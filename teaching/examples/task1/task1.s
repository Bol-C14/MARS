.data
buffer: .space 4096 # scratch space to hold the whole file
error_text: .asciiz "Error opening file"

.text
.globl task1
task1:
        addiu $sp, $sp, -8
        sw $ra, 4($sp)
        sw $s0, 0($sp)
        la $a1, buffer                      # a1 = destination buffer for loadFile
        li $a2, 4096                        # a2 = buffer capacity
        jal loadFile                        # loadFile ($a0 = filename, $a1 = buffer, $a2 = capacity)
        nop
        move $s0, $v0                       # $s0 = number of bytes read, or -1 on error
        bltz $s0, task1_error
        nop
        la $s0, buffer                      # reuse $s0 as a cursor into the buffer

task1_loop:
        lbu $t0, 0($s0)                     # load the next byte
        beqz $t0, task1_done                # stop at the NUL byte written by loadFile
        nop
        move $a0, $t0
        jal printChar
        nop
        addiu $s0, $s0, 1
        b task1_loop
        nop

task1_done:
        move $v0, $zero                     # success, matches "return 0;" in C
        lw $s0, 0($sp)
        lw $ra, 4($sp)
        addiu $sp, $sp, 8
        jr $ra
        nop

task1_error:
        la $a0, error_text
        jal printString
        nop
        move $v0, $s0                       # propagate the -1 error code
        lw $s0, 0($sp)
        lw $ra, 4($sp)
        addiu $sp, $sp, 8
        jr $ra
        nop
