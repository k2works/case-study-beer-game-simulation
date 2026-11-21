pub fn f() -> i32 {
    let x = 1;
    unsafe { *(&x as *const i32) }
}
