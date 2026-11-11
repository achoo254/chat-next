//! Fixed-capacity ring of raw PTY output addressed by absolute output offset.

/// Keeps the newest `capacity` bytes of a stream. Byte `i` of the stream lives
/// at `buf[i % capacity]` while `start() <= i < end()`.
pub struct Ring {
    buf: Vec<u8>,
    end: u64,
}

impl Ring {
    pub fn new(capacity: usize) -> Self {
        Ring {
            buf: vec![0; capacity.max(1)],
            end: 0,
        }
    }

    fn capacity_u64(&self) -> u64 {
        self.buf.len() as u64
    }

    pub fn capacity(&self) -> usize {
        self.buf.len()
    }

    /// Offset of the oldest byte still held.
    pub fn start(&self) -> u64 {
        self.end.saturating_sub(self.capacity_u64())
    }

    /// Offset one past the newest byte (total bytes ever pushed).
    pub fn end(&self) -> u64 {
        self.end
    }

    /// Whether every byte from `offset` up to `end()` is still held.
    pub fn holds_from(&self, offset: u64) -> bool {
        offset >= self.start() && offset <= self.end
    }

    pub fn push(&mut self, mut data: &[u8]) {
        let cap = self.buf.len();
        if data.len() > cap {
            // Only the tail can survive; account for the skipped bytes.
            let skip = data.len() - cap;
            self.end += skip as u64;
            data = &data[skip..];
        }
        let pos = (self.end % self.capacity_u64()) as usize;
        let first = data.len().min(cap - pos);
        self.buf[pos..pos + first].copy_from_slice(&data[..first]);
        self.buf[..data.len() - first].copy_from_slice(&data[first..]);
        self.end += data.len() as u64;
    }

    /// Append up to `max` bytes starting at `from` to `out`; returns how many.
    /// Returns 0 when `from` is no longer (or not yet) held.
    pub fn read_into(&self, from: u64, max: usize, out: &mut Vec<u8>) -> usize {
        if !self.holds_from(from) {
            return 0;
        }
        let n = ((self.end - from) as usize).min(max);
        let cap = self.buf.len();
        let pos = (from % self.capacity_u64()) as usize;
        let first = n.min(cap - pos);
        out.extend_from_slice(&self.buf[pos..pos + first]);
        out.extend_from_slice(&self.buf[..n - first]);
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(r: &Ring, from: u64, max: usize) -> Vec<u8> {
        let mut v = Vec::new();
        r.read_into(from, max, &mut v);
        v
    }

    #[test]
    fn keeps_newest_bytes_across_wraps() {
        let mut r = Ring::new(8);
        r.push(b"abcdef");
        assert_eq!((r.start(), r.end()), (0, 6));
        r.push(b"ghij");
        assert_eq!((r.start(), r.end()), (2, 10));
        assert_eq!(read(&r, 2, 100), b"cdefghij");
        assert_eq!(read(&r, 7, 2), b"hi");
        assert!(!r.holds_from(1));
        assert_eq!(read(&r, 1, 100), b"");
        assert_eq!(read(&r, 10, 100), b"");
        assert!(!r.holds_from(11));
    }

    #[test]
    fn oversized_push_keeps_tail_and_offsets() {
        let mut r = Ring::new(4);
        r.push(b"0123456789");
        assert_eq!((r.start(), r.end()), (6, 10));
        assert_eq!(read(&r, 6, 10), b"6789");
    }

    #[test]
    fn stream_is_reproduced_exactly_by_offset() {
        let mut r = Ring::new(1000);
        let mut all = Vec::new();
        for i in 0..500u32 {
            let chunk: Vec<u8> = (0..(i % 37 + 1)).map(|j| (i * 7 + j) as u8).collect();
            r.push(&chunk);
            all.extend_from_slice(&chunk);
        }
        let start = r.start();
        let mut got = Vec::new();
        let mut at = start;
        while at < r.end() {
            at += r.read_into(at, 97, &mut got) as u64;
        }
        assert_eq!(&got[..], &all[start as usize..]);
    }
}
