; ============================================================
; Sample x86-64 Assembly (NASM / Intel syntax)
; Demonstrates instructions, registers, directives, and strings
; ============================================================

%define SYS_WRITE 1
%define SYS_EXIT  60
%define STDOUT_FD 1

section .rodata
    msg:     db "Hello from Orca x86 Assembly!", 0x0A, 0
    msg_len: equ $ - msg

section .data
    counter: dd 0x0000002A          ; decimal 42 in hex
    mask:    dq 0b1010101010101010  ; binary literal

section .bss
    buffer:  resb 64

section .text
    global _start
    extern helper_func

_start:
    ; Setup frame
    push    rbp
    mov     rbp, rsp
    sub     rsp, 32

    ; Print greeting message
    mov     rax, SYS_WRITE          ; sys_write
    mov     rdi, STDOUT_FD          ; fd = stdout
    lea     rsi, [rel msg]          ; pointer to string
    mov     rdx, msg_len            ; count
    syscall

    ; Arithmetic & Logic test
    mov     eax, dword [counter]
    add     eax, 10
    imul    eax, 2
    xor     ecx, ecx
    test    eax, eax
    jz      .zero_case

    ; Loop test
    mov     rcx, 5
.loop:
    inc     dword [counter]
    dec     rcx
    jnz     .loop

    ; Exit successfully
    mov     rax, SYS_EXIT
    xor     rdi, rdi                ; exit code 0
    syscall

.zero_case:
    mov     rax, SYS_EXIT
    mov     rdi, 1                  ; exit code 1
    syscall
