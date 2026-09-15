// `cante serve` ownership: spawn, JSONL framing, op ids, event ring, state.
// TODO(A): implement per CONTRACT.md.
#![allow(unused)]
use serde_json::{json, Value};

#[tauri::command]
pub fn health() -> Value {
    json!({ "ok": false, "cante": Value::Null, "cwd": "", "daemon": false, "status": "offline" })
}

macro_rules! todo_command {
    ($name:ident) => {
        #[tauri::command]
        pub fn $name() -> Result<Value, String> {
            Err("not implemented yet".into())
        }
    };
}
todo_command!(events_since);
todo_command!(start_session);
todo_command!(update_session);
todo_command!(send_input);
todo_command!(approve);
todo_command!(interrupt);
todo_command!(compact);
todo_command!(context_report);
todo_command!(slash);
todo_command!(goal);
todo_command!(catalog);
todo_command!(set_cwd);
todo_command!(shutdown);
