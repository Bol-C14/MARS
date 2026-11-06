# Example 4 · One number, several notations
# Reads an integer and prints it in decimal, hexadecimal and 32-bit binary, and counts its 1 bits.
# Try it: enter 898 or -1; on the srl line use bit by bit in focus mode to watch the shift; switch Numbers in the footer to BIN to compare with the registers.

.data
ask:     .asciiz "Enter an integer: "
decT:    .asciiz "Decimal:  "
hexT:    .asciiz "\nHex:      0x"
binT:    .asciiz "\nBinary:   "
onesT:   .asciiz "\nOne bits: "
digits:  .ascii  "0123456789abcdef"   # the 16 hexadecimal digits, in order of value
newline: .asciiz "\n"

.text
.globl main
main:
    li   $v0, 4
    la   $a0, ask
    syscall
    li   $v0, 5            # read an integer
    syscall
    move $s0, $v0          # $s0 = the number

    li   $v0, 4
    la   $a0, decT
    syscall
    move $a0, $s0
    li   $v0, 1            # decimal is printed by the syscall itself
    syscall

# Hexadecimal: every 4 bits make one digit, from the top 4 bits down, 8 digits in all
    li   $v0, 4
    la   $a0, hexT
    syscall
    li   $t0, 28           # how far to shift right: 28, 24, …, 0
hex_loop:
    srlv $t1, $s0, $t0     # move these 4 bits to the bottom
    andi $t1, $t1, 0xf     # keep only the lowest 4 bits: 0–15
    la   $t2, digits
    addu $t2, $t2, $t1     # the address of character number $t1 in the digit table
    lbu  $a0, 0($t2)
    li   $v0, 11           # $v0 = 11: print one character
    syscall
    addiu $t0, $t0, -4
    bgez $t0, hex_loop     # more groups of 4 bits to print
    nop

# Binary: print the top bit, shift the next bit up, and count the 1s on the way
    li   $v0, 4
    la   $a0, binT
    syscall
    move $t3, $s0          # shift a copy so $s0 stays as it is
    li   $t0, 32           # bits left
    li   $s1, 0            # $s1 = number of 1 bits
bin_loop:
    srl  $t1, $t3, 31      # the top bit moved to the bottom: 0 or 1
    addu $s1, $s1, $t1
    addiu $a0, $t1, 48     # 0 or 1 plus 48 is the character '0' or '1'
    li   $v0, 11
    syscall
    sll  $t3, $t3, 1       # move the next bit to the top
    addiu $t0, $t0, -1
    bnez $t0, bin_loop
    nop

    li   $v0, 4
    la   $a0, onesT
    syscall
    move $a0, $s1
    li   $v0, 1
    syscall
    li   $v0, 4
    la   $a0, newline
    syscall
    li   $v0, 10
    syscall
