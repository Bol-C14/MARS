.data
filename: .asciiz "input.txt"

.text
main:
        la      $a0, filename
        jal     task1
        nop

        move    $a0, $v0
        li      $v0, 17
        syscall
