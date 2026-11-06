# Example 3 · Loops and branches: FizzBuzz
# Counts from 1 to limit: multiples of 3 print Fizz, multiples of 5 print Buzz, multiples of both print FizzBuzz, and the rest print the number.
# Try it: open focus mode to see each branch taken or not; change limit to another number.

.data
limit:   .word 15          # how far to count
fizz:    .asciiz "Fizz"
buzz:    .asciiz "Buzz"
newline: .asciiz "\n"

.text
.globl main
main:
    lw   $s1, limit        # $s1 = limit
    li   $s0, 1            # $s0 = i, starting at 1
    li   $s2, 3
    li   $s3, 5

loop:
    bgt  $s0, $s1, done    # i > limit: finished
    nop
    li   $t2, 0            # $t2 = whether this line printed a word yet

    div  $s0, $s2          # i ÷ 3, the remainder is in HI
    mfhi $t0
    bnez $t0, not_fizz     # remainder not 0: not a multiple of 3
    nop
    li   $v0, 4
    la   $a0, fizz
    syscall
    li   $t2, 1
not_fizz:

    div  $s0, $s3          # i ÷ 5
    mfhi $t1
    bnez $t1, not_buzz
    nop
    li   $v0, 4
    la   $a0, buzz
    syscall
    li   $t2, 1
not_buzz:

    bnez $t2, next_line    # Fizz or Buzz printed: skip the number
    nop
    move $a0, $s0
    li   $v0, 1
    syscall
next_line:
    li   $v0, 4
    la   $a0, newline
    syscall
    addiu $s0, $s0, 1      # i = i + 1
    j    loop
    nop

done:
    li   $v0, 10
    syscall
