# Statistics: read the numbers in the text into an array, then work out the total, lowest and highest.

.data
.globl total
.globl lowest
.globl highest
total:   .word 0
lowest:  .word 0
highest: .word 0

.text
.globl readScores
# readScores: $a0 = the text, $a1 = the array for the scores, $a2 = how many fit
# returns $v0 = how many scores were read
readScores:
    addiu $sp, $sp, -16    # save $ra and the $s registers used here (callee-saved)
    sw   $ra, 12($sp)
    sw   $s0, 8($sp)
    sw   $s1, 4($sp)
    sw   $s2, 0($sp)
    move $s0, $a1          # $s0 = where the next score goes
    move $s1, $zero        # $s1 = how many so far
    move $s2, $a2          # $s2 = at most how many
read_loop:
    beq  $s1, $s2, read_done   # the array is full
    nop
    jal  nextInt           # in text.s: $a0 = where to read
    nop
    beqz $v1, read_done    # no number left
    nop
    sw   $v0, 0($s0)
    addiu $s0, $s0, 4      # each score takes 4 bytes
    addiu $s1, $s1, 1
    move $a0, $v1          # continue after the last number
    j    read_loop
    nop
read_done:
    move $v0, $s1
    lw   $s2, 0($sp)       # restore the saved registers
    lw   $s1, 4($sp)
    lw   $s0, 8($sp)
    lw   $ra, 12($sp)
    addiu $sp, $sp, 16
    jr   $ra
    nop

.globl summarize
# summarize: $a0 = the scores, $a1 = how many (at least 1); results go into total, lowest and highest
summarize:
    lw   $t0, 0($a0)       # start from the first score
    move $t1, $t0          # $t1 = total
    move $t2, $t0          # $t2 = lowest
    move $t3, $t0          # $t3 = highest
    li   $t4, 1            # $t4 = i
sum_loop:
    beq  $t4, $a1, sum_done
    nop
    sll  $t5, $t4, 2       # score i is at byte i × 4
    addu $t5, $a0, $t5
    lw   $t6, 0($t5)
    addu $t1, $t1, $t6
    bge  $t6, $t2, not_lower
    nop
    move $t2, $t6          # lower
not_lower:
    ble  $t6, $t3, not_higher
    nop
    move $t3, $t6          # higher
not_higher:
    addiu $t4, $t4, 1
    j    sum_loop
    nop
sum_done:
    sw   $t1, total
    sw   $t2, lowest
    sw   $t3, highest
    jr   $ra
    nop
