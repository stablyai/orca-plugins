// ============================================================
// Sample ARM / AArch64 Assembly
// Demonstrates AArch64 registers (x0-x30), ADRP, SVC, and NEON
// ============================================================

    .arch armv8-a
    .text
    .align  2
    .global _start
    .type   _start, %function

_start:
    // Write string to stdout
    mov     x0, #1                  // stdout
    adrp    x1, msg                 // page of msg
    add     x1, x1, :lo12:msg       // offset of msg
    mov     x2, #26                 // length
    mov     x8, #64                 // syscall: __NR_write (Linux AArch64)
    svc     #0

    // Test data processing
    mov     w3, #10
    add     w3, w3, #5
    sub     w4, w3, #2
    mul     w5, w3, w4

    // Exit
    mov     x0, #0                  // status 0
    mov     x8, #93                 // syscall: __NR_exit
    svc     #0

    .data
    .align  3
msg:
    .asciz  "Hello from AArch64 ARM!\n"
    .size   msg, .-msg
