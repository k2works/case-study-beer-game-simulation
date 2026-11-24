pub enum State {
    Empty,
    HasItems,
    Done,
}

pub fn f(s: State) -> i32 {
    match s {
        State::Empty => 0,
        _ => 1,
    }
}
