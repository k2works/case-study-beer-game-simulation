pub enum State {
    Empty,
    HasItems,
}

pub enum Command {
    Add,
    Clear,
}

pub fn f(s: State, c: Command) -> i32 {
    match (s, c) {
        (State::Empty, Command::Add) => 1,
        _ => 0,
    }
}
