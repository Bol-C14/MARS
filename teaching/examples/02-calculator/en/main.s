# Example 2 · Calculator
# Reads two integers a and b and prints a + b, a − b, a × b, and the quotient and remainder of a ÷ b.
# Try it: when it runs, type a number in the terminal at the bottom and press Enter; then try 0 as the second number.

.data
askA:   .asciiz "First integer: "
askB:   .asciiz "Second integer: "
sumT:   .asciiz "a + b = "
diffT:  .asciiz "\na - b = "
prodT:  .asciiz "\na * b = "
quotT:  .asciiz "\na / b = "
remT:   .asciiz " remainder "
zeroT:  .asciiz "\nCannot divide by 0"
newline: .asciiz "\n"

.text
.globl main
main:
    li   $v0, 4            # print the prompt
    la   $a0, askA
    syscall
    li   $v0, 5            # $v0 = 5: read an integer; the number read goes into $v0
    syscall
    move $s0, $v0          # $s0 = a

    li   $v0, 4
    la   $a0, askB
    syscall
    li   $v0, 5
    syscall
    move $s1, $v0          # $s1 = b

    li   $v0, 4
    la   $a0, sumT
    syscall
    addu $a0, $s0, $s1     # add; addu does not stop on overflow
    li   $v0, 1            # $v0 = 1: print the integer in $a0
    syscall

    li   $v0, 4
    la   $a0, diffT
    syscall
    subu $a0, $s0, $s1     # subtract
    li   $v0, 1
    syscall

    li   $v0, 4
    la   $a0, prodT
    syscall
    mul  $a0, $s0, $s1     # multiply, keeping the low 32 bits of the product
    li   $v0, 1
    syscall

    beqz $s1, no_divide    # b is 0: no division
    nop                    # delay slot: with delayed branching on, this always runs first
    div  $s0, $s1          # the quotient goes into LO, the remainder into HI
    li   $v0, 4
    la   $a0, quotT
    syscall
    mflo $a0               # read the quotient
    li   $v0, 1
    syscall
    li   $v0, 4
    la   $a0, remT
    syscall
    mfhi $a0               # read the remainder
    li   $v0, 1
    syscall
    j    finish
    nop

no_divide:
    li   $v0, 4
    la   $a0, zeroT
    syscall

finish:
    li   $v0, 4
    la   $a0, newline
    syscall
    li   $v0, 10
    syscall
