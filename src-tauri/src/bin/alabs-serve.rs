//! `alabs-serve`: the local process that serves alabs to Chrome.
//!
//! It links the shared core in `alabs_lib` and never links Tauri. One process
//! owns one alabs root, given as the single argument; changing roots means
//! restarting with another path.

fn main() -> std::process::ExitCode {
    alabs_lib::serve_main(std::env::args().skip(1).collect())
}
