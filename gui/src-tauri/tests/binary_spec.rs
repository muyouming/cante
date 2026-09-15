//! `CANTE_BIN` is a command spec, not just a path.
//!
//! Windows cannot execute a `#!` script directly, so the tests point `CANTE_BIN`
//! at `"bun <script>"`; the daemon appends its own `serve` subcommand after the
//! leading arguments. Paths may be quoted because a Windows path may contain
//! spaces.
use cante_gui_lib::daemon::split_binary;

#[test]
fn a_bare_program_has_no_arguments() {
    let (program, args) = split_binary("cante");
    assert_eq!(program, "cante");
    assert!(args.is_empty());
}

#[test]
fn leading_arguments_are_kept_in_order() {
    let (program, args) = split_binary("bun /opt/fixtures/fake-cante.ts");
    assert_eq!(program, "bun");
    assert_eq!(args, vec!["/opt/fixtures/fake-cante.ts".to_string()]);
}

#[test]
fn quoted_tokens_survive_spaces() {
    let (program, args) = split_binary(r#""C:\Program Files\bun\bun.exe" "C:\my scripts\fake-cante.ts""#);
    assert_eq!(program, r"C:\Program Files\bun\bun.exe");
    assert_eq!(args, vec![r"C:\my scripts\fake-cante.ts".to_string()]);
}

#[test]
fn extra_whitespace_is_ignored() {
    let (program, args) = split_binary("   bun    script.ts   ");
    assert_eq!(program, "bun");
    assert_eq!(args, vec!["script.ts".to_string()]);
}

#[test]
fn an_empty_spec_falls_back_to_the_default_binary() {
    let (program, args) = split_binary("   ");
    assert_eq!(program, "cante");
    assert!(args.is_empty());
}
