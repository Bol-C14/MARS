.data
prompt: .asciiz "Enter an integer: "
result: .asciiz "Hex: "
.text
.globl main
main:
 li $v0,4
 la $a0,prompt
 syscall
 li $v0,5
 syscall
 move $s0,$v0
 li $v0,4
 la $a0,result
 syscall
 li $t0,8
loop:
 srl $t1,$s0,28
 slti $t2,$t1,10
 beq $t2,$zero,over10
 nop
 addiu $t1,$t1,48
 j print
 nop
over10:
 addiu $t1,$t1,55
print:
 li $v0,11
 move $a0,$t1
 syscall
 sll $s0,$s0,4
 addiu $t0,$t0,-1
 bne $t0,$zero,loop
 nop
 li $v0,10
 syscall
