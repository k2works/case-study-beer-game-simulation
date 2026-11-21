pub enum State {
    Empty,
    HasItems,
}

pub fn f(s: State, v: &[i32]) -> i32 {
    match s {
        State::Empty => v.first().copied().unwrap_or(0),
        State::HasItems => 1,
    }
}
