# ============================================================
# Sample x86-64 Assembly (GAS / AT&T syntax)
# Demonstrates GNU Assembler directives, %registers, and $immediates
# ============================================================

    .file   "hello_att.s"
    .section    .rodata
.LC0:
    .string "Hello from AT&T GAS Assembly!"

    .text
    .globl  compute_square
    .type   compute_square, @function

compute_square:
    .cfi_startproc
    pushq   %rbp
    .cfi_def_cfa_offset 16
    .cfi_offset 6, -16
    movq    %rsp, %rbp
    .cfi_def_cfa_register 6

    movl    %edi, -4(%rbp)
    movl    -4(%rbp), %eax
    imull   -4(%rbp), %eax

    popq    %rbp
    .cfi_def_cfa 7, 8
    ret
    .cfi_endproc
    .size   compute_square, .-compute_square

    .globl  _start
    .type   _start, @function
_start:
    movl    $5, %edi
    call    compute_square

    # Exit with the computed result
    movl    %eax, %edi
    movl    $60, %eax               # syscall: sys_exit
    syscall
    .size   _start, .-_start
