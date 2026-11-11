//! Windows named pipe transport. The pipe name is random and written to
//! `control.json`; the first instance is created with
//! `FILE_FLAG_FIRST_PIPE_INSTANCE` (no one can pre-create the name), the DACL
//! grants access to the daemon's own user only, remote clients are rejected,
//! and the user SID of every connecting process is compared with ours.
//!
//! All I/O is overlapped so one thread can block in a read while another
//! writes on the same pipe.
//!
//! Compile-checked only (x86_64-pc-windows-gnu); not yet run on Windows.

use std::ffi::c_void;
use std::io::{self, Read, Write};
use std::path::Path;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA,
    ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
    OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
    PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, OpenProcess, OpenProcessToken, WaitForSingleObject, INFINITE,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

const PIPE_BUFFER: u32 = 64 * 1024;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// An owned kernel handle closed on drop.
struct Handle(HANDLE);

// SAFETY: a Windows kernel handle may be used from any thread; overlapped
// operations on it use a separate OVERLAPPED and event per caller.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            // SAFETY: we own the handle and close it exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn new_event() -> io::Result<Handle> {
    // SAFETY: manual-reset, unnamed event with default security.
    let h = unsafe { CreateEventW(null(), 1, 0, null()) };
    if h.is_null() {
        Err(io::Error::last_os_error())
    } else {
        Ok(Handle(h))
    }
}

/// A connected pipe end with its own event for overlapped I/O.
pub struct Stream {
    pipe: Arc<Handle>,
    event: Handle,
    /// Milliseconds; 0 = no timeout.
    read_timeout: AtomicU32,
    write_timeout: AtomicU32,
}

impl Stream {
    fn from_handle(pipe: Arc<Handle>) -> io::Result<Stream> {
        Ok(Stream {
            pipe,
            event: new_event()?,
            read_timeout: AtomicU32::new(0),
            write_timeout: AtomicU32::new(0),
        })
    }

    pub fn try_clone(&self) -> io::Result<Stream> {
        Stream::from_handle(self.pipe.clone())
    }

    pub fn shutdown(&self) {
        // SAFETY: valid handle; cancels pending I/O of every thread on it.
        unsafe {
            CancelIoEx(self.pipe.0, null());
            DisconnectNamedPipe(self.pipe.0);
        }
    }

    pub fn set_read_timeout(&self, t: Option<Duration>) {
        self.read_timeout.store(timeout_ms(t), Ordering::Relaxed);
    }

    pub fn set_write_timeout(&self, t: Option<Duration>) {
        self.write_timeout.store(timeout_ms(t), Ordering::Relaxed);
    }

    fn io(&self, read: bool, ptr: *mut u8, len: usize) -> io::Result<usize> {
        let len = len.min(u32::MAX as usize) as u32;
        // SAFETY: OVERLAPPED is plain data; all-zero is its documented
        // initial state. The event is ours and outlives the operation, which
        // is always completed (or cancelled and completed) before returning.
        unsafe {
            let mut ov: OVERLAPPED = std::mem::zeroed();
            ov.hEvent = self.event.0;
            let started = if read {
                ReadFile(self.pipe.0, ptr, len, null_mut(), &mut ov)
            } else {
                WriteFile(self.pipe.0, ptr, len, null_mut(), &mut ov)
            };
            if started == 0 {
                let err = GetLastError();
                if err != ERROR_IO_PENDING {
                    return pipe_result(read, err, 0);
                }
            }
            let timeout = if read {
                self.read_timeout.load(Ordering::Relaxed)
            } else {
                self.write_timeout.load(Ordering::Relaxed)
            };
            if timeout != 0 && WaitForSingleObject(self.event.0, timeout) != WAIT_OBJECT_0 {
                CancelIoEx(self.pipe.0, &ov);
                let mut n = 0u32;
                GetOverlappedResult(self.pipe.0, &ov, &mut n, 1);
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "pipe I/O timed out",
                ));
            }
            let mut n = 0u32;
            if GetOverlappedResult(self.pipe.0, &ov, &mut n, 1) == 0 {
                return pipe_result(read, GetLastError(), n);
            }
            Ok(n as usize)
        }
    }
}

fn timeout_ms(t: Option<Duration>) -> u32 {
    t.map_or(0, |d| {
        d.as_millis().clamp(1, u128::from(INFINITE - 1)) as u32
    })
}

/// A closed pipe reads as EOF; anything else is an error.
fn pipe_result(read: bool, err: u32, n: u32) -> io::Result<usize> {
    if read && (err == ERROR_BROKEN_PIPE || err == ERROR_NO_DATA) {
        Ok(n as usize)
    } else {
        Err(io::Error::from_raw_os_error(err as i32))
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.io(true, buf.as_mut_ptr(), buf.len())
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // WriteFile does not write through the pointer.
        self.io(false, buf.as_ptr() as *mut u8, buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Security descriptor allocated by LocalAlloc inside the SDDL conversion.
struct Descriptor(PSECURITY_DESCRIPTOR);

// SAFETY: the descriptor is immutable after creation.
unsafe impl Send for Descriptor {}
unsafe impl Sync for Descriptor {}

impl Drop for Descriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe { LocalFree(self.0 as _) };
    }
}

/// The user SID of a process token, as owned bytes.
fn token_user_sid(process: HANDLE) -> io::Result<Vec<u8>> {
    // SAFETY: standard two-call pattern for GetTokenInformation; the buffer
    // outlives every pointer into it and the token handle is closed by Handle.
    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = Handle(token);
        let mut len = 0u32;
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut len);
        if len == 0 {
            return Err(io::Error::last_os_error());
        }
        // u64 storage keeps TOKEN_USER suitably aligned.
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        if GetTokenInformation(
            token.0,
            TokenUser,
            buf.as_mut_ptr() as *mut c_void,
            len,
            &mut len,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let sid = user.User.Sid;
        let bytes = std::slice::from_raw_parts(buf.as_ptr() as *const u8, buf.len() * 8);
        let offset = (sid as usize).wrapping_sub(buf.as_ptr() as usize);
        bytes
            .get(offset..)
            .map(|b| b.to_vec())
            .ok_or_else(|| io::Error::other("SID outside the token buffer"))
    }
}

fn own_sid() -> io::Result<Vec<u8>> {
    // SAFETY: pseudo handle of the current process, never closed.
    token_user_sid(unsafe { GetCurrentProcess() })
}

fn sid_string(sid: &[u8]) -> io::Result<String> {
    // SAFETY: `sid` holds a valid SID copied from a token; the returned
    // string is freed with LocalFree.
    unsafe {
        let mut out: *mut u16 = null_mut();
        if ConvertSidToStringSidW(sid.as_ptr() as *mut c_void, &mut out) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut n = 0;
        while *out.add(n) != 0 {
            n += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(out, n));
        LocalFree(out as _);
        Ok(s)
    }
}

/// Give `path` a protected DACL that grants full access to the daemon's own
/// user only (the Windows equivalent of 0700 / 0600). `inherit` makes the
/// entry apply to files and directories created inside it.
// Windows only: compile-checked with x86_64-pc-windows-gnu, not run yet.
pub(crate) fn restrict_to_owner(path: &Path, inherit: bool) -> io::Result<()> {
    use windows_sys::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION,
    };

    let sid = sid_string(&own_sid()?)?;
    let flags = if inherit { "OICI" } else { "" };
    let sddl = wide(&format!("D:P(A;{flags};FA;;;{sid})"));
    let mut sd: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: valid NUL-terminated SDDL; the descriptor is freed by Descriptor.
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut sd,
            null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let sd = Descriptor(sd);
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl: *mut ACL = null_mut();
    // SAFETY: `sd` is a valid descriptor; `dacl` points into it and is used
    // only while `sd` is alive.
    if unsafe { GetSecurityDescriptorDacl(sd.0, &mut present, &mut dacl, &mut defaulted) } == 0
        || present == 0
    {
        return Err(io::Error::other("descriptor without DACL"));
    }
    let name = wide(&path.to_string_lossy());
    // SAFETY: `name` is NUL-terminated and `dacl` stays valid (owned by `sd`)
    // for the duration of the call.
    let rc = unsafe {
        SetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            dacl,
            null(),
        )
    };
    drop(sd);
    if rc != 0 {
        return Err(io::Error::from_raw_os_error(rc as i32));
    }
    Ok(())
}

/// Whether the process at the other end of `pipe` runs as `own`.
fn client_is_owner(pipe: HANDLE, own: &[u8]) -> bool {
    // SAFETY: valid pipe handle; the process handle is closed by Handle.
    unsafe {
        let mut pid = 0u32;
        if GetNamedPipeClientProcessId(pipe, &mut pid) == 0 {
            return false;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let process = Handle(process);
        match token_user_sid(process.0) {
            Ok(sid) => EqualSid(sid.as_ptr() as *mut c_void, own.as_ptr() as *mut c_void) != 0,
            Err(_) => false,
        }
    }
}

pub struct Listener {
    name: Vec<u16>,
    descriptor: Descriptor,
    own: Vec<u8>,
    next: Option<Arc<Handle>>,
}

impl Listener {
    /// Create the first instance of `\\.\pipe\<name>`. Fails if anyone else
    /// already owns that name.
    pub fn bind_pipe(name: &str) -> io::Result<Listener> {
        let own = own_sid()?;
        let sddl = wide(&format!("D:P(A;;GA;;;{})", sid_string(&own)?));
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: valid NUL-terminated SDDL; the descriptor is freed by Descriptor.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut l = Listener {
            name: wide(&format!(r"\\.\pipe\{name}")),
            descriptor: Descriptor(sd),
            own,
            next: None,
        };
        l.next = Some(l.instance(true)?);
        Ok(l)
    }

    fn instance(&self, first: bool) -> io::Result<Arc<Handle>> {
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.0,
            bInheritHandle: 0,
        };
        let mut open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
        if first {
            open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
        }
        // SAFETY: valid name and security attributes for the call's duration.
        let h = unsafe {
            CreateNamedPipeW(
                self.name.as_ptr(),
                open_mode,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                PIPE_BUFFER,
                PIPE_BUFFER,
                0,
                &sa,
            )
        };
        if h == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(Arc::new(Handle(h)))
    }

    /// Wait for the next client. `Ok(None)` when it is not our user.
    pub fn accept(&mut self) -> io::Result<Option<Stream>> {
        let pipe = match self.next.take() {
            Some(p) => p,
            None => self.instance(false)?,
        };
        let stream = Stream::from_handle(pipe.clone())?;
        // SAFETY: see Stream::io; the operation completes before returning.
        unsafe {
            let mut ov: OVERLAPPED = std::mem::zeroed();
            ov.hEvent = stream.event.0;
            if ConnectNamedPipe(pipe.0, &mut ov) == 0 {
                match GetLastError() {
                    ERROR_PIPE_CONNECTED => {}
                    ERROR_IO_PENDING => {
                        let mut n = 0u32;
                        if GetOverlappedResult(pipe.0, &ov, &mut n, 1) == 0 {
                            return Err(io::Error::last_os_error());
                        }
                    }
                    err => return Err(io::Error::from_raw_os_error(err as i32)),
                }
            }
        }
        if client_is_owner(pipe.0, &self.own) {
            Ok(Some(stream))
        } else {
            stream.shutdown();
            Ok(None)
        }
    }
}

/// Connect to a daemon's pipe (`\\.\pipe\...`).
pub fn connect(path: &Path) -> io::Result<Stream> {
    let name = wide(&path.to_string_lossy());
    // SAFETY: valid NUL-terminated name; the handle is owned by Handle.
    let h = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED,
            null_mut(),
        )
    };
    if h == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Stream::from_handle(Arc::new(Handle(h)))
}
