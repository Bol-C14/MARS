.text
# Supplied MARS I/O. Arguments: $a0-$a2; result: $v0.
# Helpers may overwrite $t0-$t9, $a0-$a3 and $v0-$v1.
.globl printChar
printChar:
    li $v0, 11
    syscall
    jr $ra
    nop
.globl printInt
printInt:
    li $v0, 1
    syscall
    jr $ra
    nop
.globl printString
printString:
    li $v0, 4
    syscall
    jr $ra
    nop
.globl printLn
printLn:
    li $a0, 10
    li $v0, 11
    syscall
    jr $ra
    nop
.globl readInt
readInt:
    li $v0, 5
    syscall
    jr $ra
    nop
.globl readString
readString:
    move $t0, $a0
    li $v0, 8
    syscall
    move $v0, $zero
io_string_loop:
    lbu $t1, 0($t0)
    beqz $t1, io_string_done
    nop
    beq $t1, 10, io_string_end
    nop
    beq $t1, 13, io_string_end
    nop
    addiu $t0, $t0, 1
    addiu $v0, $v0, 1
    b io_string_loop
    nop
io_string_end:
    sb $zero, 0($t0)
io_string_done:
    jr $ra
    nop
.globl loadFile
# filename, destination, capacity -> length or -1; adds a NUL byte.
loadFile:
    move $t0, $a1
    addiu $t1, $a2, -1
    li $a1, 0
    li $a2, 0
    li $v0, 13
    syscall
    bltz $v0, io_return_error
    nop
    move $t2, $v0
    move $t3, $zero
io_read_loop:
    move $a0, $t2
    addu $a1, $t0, $t3
    subu $a2, $t1, $t3
    beqz $a2, io_check_extra
    nop
    li $v0, 14
    syscall
    bltz $v0, io_read_error
    nop
    beqz $v0, io_read_done
    nop
    addu $t3, $t3, $v0
    b io_read_loop
    nop
io_check_extra:
    li $a2, 1
    li $v0, 14
    syscall
    bnez $v0, io_read_error
    nop
io_read_done:
    addu $t4, $t0, $t3
    sb $zero, 0($t4)
    move $a0, $t2
    li $v0, 16
    syscall
    move $v0, $t3
    jr $ra
    nop
io_read_error:
    move $a0, $t2
    li $v0, 16
    syscall
io_return_error:
    li $v0, -1
    jr $ra
    nop
.globl saveFile
# filename, source, length -> 0 or -1.
saveFile:
    move $t0, $a1
    move $t1, $a2
    li $a1, 1
    li $a2, 0
    li $v0, 13
    syscall
    bltz $v0, io_return_error
    nop
    move $t2, $v0
io_write_loop:
    beqz $t1, io_write_done
    nop
    move $a0, $t2
    move $a1, $t0
    move $a2, $t1
    li $v0, 15
    syscall
    blez $v0, io_read_error
    nop
    addu $t0, $t0, $v0
    subu $t1, $t1, $v0
    b io_write_loop
    nop
io_write_done:
    move $a0, $t2
    li $v0, 16
    syscall
    move $v0, $zero
    jr $ra
    nop
