# Example 5 · Project: grade statistics
# Reads the scores in input.txt (one per line), works out the count, total, lowest, highest and average,
# prints them in the terminal and writes them to report.txt.
# Files: main.s the main flow · fileio.s reading and writing files · text.s text and numbers · stats.s statistics
# Try it: change the scores in input.txt and run again; Step Over functions you already understand, Step Out to get back to the caller.

.data
inputName:  .asciiz "input.txt"
outputName: .asciiz "report.txt"
buffer:     .space 4096    # the whole of input.txt is read into here
.align 2                   # start the next item at a multiple of 4: lw/sw need word alignment
scores:     .space 400     # up to 100 scores, 4 bytes each
report:     .space 256     # the report text is put together here first
openError:  .asciiz "Cannot open input.txt\n"
noScores:   .asciiz "No scores found\n"
countT:     .asciiz "Scores:  "
totalT:     .asciiz "\nTotal:   "
lowestT:    .asciiz "\nLowest:  "
highestT:   .asciiz "\nHighest: "
averageT:   .asciiz "\nAverage: "
newline:    .asciiz "\n"

.text
.globl main
main:
    la   $a0, inputName
    la   $a1, buffer
    li   $a2, 4096
    jal  loadFile          # in fileio.s: $v0 = bytes read, negative if it cannot be opened
    nop
    bltz $v0, open_failed
    nop

    la   $a0, buffer
    la   $a1, scores
    li   $a2, 100
    jal  readScores        # in stats.s: $v0 = how many scores were read
    nop
    move $s0, $v0          # $s0 = number of scores
    beqz $s0, no_scores
    nop

    la   $a0, scores
    move $a1, $s0
    jal  summarize         # in stats.s: works out total, lowest and highest
    nop

# Put the report together in report: each append returns where the next part goes
    la   $a0, report
    la   $a1, countT
    jal  appendText
    nop
    move $a0, $v0
    move $a1, $s0
    jal  appendInt
    nop
    move $a0, $v0
    la   $a1, totalT
    jal  appendText
    nop
    move $a0, $v0
    lw   $a1, total        # total is defined in stats.s and shared with .globl
    jal  appendInt
    nop
    move $a0, $v0
    la   $a1, lowestT
    jal  appendText
    nop
    move $a0, $v0
    lw   $a1, lowest
    jal  appendInt
    nop
    move $a0, $v0
    la   $a1, highestT
    jal  appendText
    nop
    move $a0, $v0
    lw   $a1, highest
    jal  appendInt
    nop
    move $a0, $v0
    la   $a1, averageT
    jal  appendText
    nop
    lw   $t0, total
    divu $t0, $s0          # average = total ÷ count (rounded down)
    mflo $a1
    move $a0, $v0
    jal  appendInt
    nop
    move $a0, $v0
    la   $a1, newline
    jal  appendText
    nop
    move $s1, $v0          # $s1 = where the report ends

    li   $v0, 4            # print the report in the terminal
    la   $a0, report
    syscall

    la   $a0, outputName   # then write the same text to report.txt
    la   $a1, report
    la   $t0, report
    subu $a2, $s1, $t0     # length = end − start
    jal  saveFile
    nop
    li   $v0, 10
    syscall

no_scores:
    li   $v0, 4
    la   $a0, noScores
    syscall
    li   $v0, 10
    syscall

open_failed:
    li   $v0, 4
    la   $a0, openError
    syscall
    li   $a0, 1            # exit code 1 means an error
    li   $v0, 17           # $v0 = 17: end with an exit code
    syscall
