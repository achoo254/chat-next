// The sidecar never uploads files (the first version sends text only), so zca-js's form-data
// and its 17 dependencies are replaced by this stub, which fails loudly if anything uses it.
export default function FormData() {
	throw new Error("file upload is disabled in this build");
}
