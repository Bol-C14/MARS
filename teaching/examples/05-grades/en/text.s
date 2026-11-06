# Converting between text and numbers.

.text
.globl nextInt
# nextInt: $a0 = where to start looking
# returns $v0 = the number found, $v1 = where to continue; $v1 = 0 when no number is left
nextInt:
skip:
    lbu  $t0, 0($a0)       # read one character
    beqz $t0, no_number    # reached the \0: the text is over
    nop
    addiu $t1, $t0, -48    # the character '0' has code 48
    sltiu $t2, $t1, 10     # 1 if it is a digit 0–9
    bnez $t2, number_start
    nop
    addiu $a0, $a0, 1      # not a digit: skip it
    j    skip
    nop
number_start:
    li   $v0, 0
digit_loop:
    lbu  $t0, 0($a0)
    addiu $t1, $t0, -48
    sltiu $t2, $t1, 10
    beqz $t2, number_done  # no longer a digit: the number ends
    nop
    li   $t3, 10
    mul  $v0, $v0, $t3     # number = number × 10 + this digit
    addu $v0, $v0, $t1
    addiu $a0, $a0, 1
    j    digit_loop
    nop
number_done:
    move $v1, $a0
    jr   $ra
    nop
no_number:
    li   $v0, 0
    li   $v1, 0
    jr   $ra
    nop

.globl appendText
# appendText: $a0 = where to write, $a1 = text ending in \0; returns $v0 = the position after it
appendText:
    lbu  $t0, 0($a1)
    beqz $t0, append_done
    nop
    sb   $t0, 0($a0)       # copy one byte at a time
    addiu $a0, $a0, 1
    addiu $a1, $a1, 1
    j    appendText
    nop
append_done:
    sb   $zero, 0($a0)     # the result always ends in \0
    move $v0, $a0
    jr   $ra
    nop

.globl appendInt
# appendInt: $a0 = where to write, $a1 = a number of at least 0; returns $v0 = the position after it
appendInt:
    addiu $sp, $sp, -12    # borrow 12 bytes on the stack for the digits
    addiu $t2, $sp, 12     # $t2 = the end of the borrowed space
    move $t4, $t2          # digits go in from the back: the units digit comes out first
    move $t0, $a1
    li   $t1, 10
digits_loop:
    divu $t0, $t1          # divide by 10: the remainder is the last digit, the quotient the rest
    mfhi $t3
    mflo $t0
    addiu $t3, $t3, 48     # the digit 0–9 becomes the character '0'–'9'
    addiu $t4, $t4, -1
    sb   $t3, 0($t4)
    bnez $t0, digits_loop
    nop
copy_loop:
    lbu  $t3, 0($t4)
    sb   $t3, 0($a0)
    addiu $a0, $a0, 1
    addiu $t4, $t4, 1
    bne  $t4, $t2, copy_loop
    nop
    addiu $sp, $sp, 12     # give the borrowed stack space back
    sb   $zero, 0($a0)
    move $v0, $a0
    jr   $ra
    nop
