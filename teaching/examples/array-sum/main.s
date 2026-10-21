# Independent example: a function reads an array and returns its sum.
.data
values: .word 7, -2, 9, 4
.text
.globl main
main:
 la $a0, values
 li $a1, 4
 jal sum
 nop
 move $a0, $v0
 li $v0, 1
 syscall
 li $v0, 10
 syscall
sum:
 move $v0, $zero
loop:
 beqz $a1, done
 nop
 lw $t0, 0($a0)
 addu $v0, $v0, $t0
 addiu $a0, $a0, 4
 addiu $a1, $a1, -1
 b loop
 nop
done:
 jr $ra
 nop
