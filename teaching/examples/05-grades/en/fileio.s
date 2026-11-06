# Reading and writing virtual files (syscall 13 open, 14 read, 15 write, 16 close).
# Files are the project's text files; files on your computer are never touched.

.text
.globl loadFile
# loadFile: $a0 = file name, $a1 = buffer, $a2 = buffer size
# returns $v0 = bytes read (followed by a \0), negative if the file cannot be opened
loadFile:
    move $t8, $a1          # remember the buffer
    move $t9, $a2          # remember the size
    li   $a1, 0            # 0 = read only
    li   $a2, 0
    li   $v0, 13           # open: $v0 = file descriptor
    syscall
    bltz $v0, load_done    # cannot open: return the negative number as it is
    nop
    move $t7, $v0          # $t7 = file descriptor
    move $a0, $t7
    move $a1, $t8
    addiu $a2, $t9, -1     # keep one byte for the final \0
    li   $v0, 14           # read: $v0 = bytes read
    syscall
    move $t6, $v0
    bgez $t6, read_ok
    nop
    li   $t6, 0            # treat a read error as an empty file
read_ok:
    addu $t5, $t8, $t6
    sb   $zero, 0($t5)     # put a \0 after what was read
    move $a0, $t7
    li   $v0, 16           # close
    syscall
    move $v0, $t6
load_done:
    jr   $ra
    nop

.globl saveFile
# saveFile: $a0 = file name, $a1 = what to write, $a2 = number of bytes
# returns $v0 = bytes written, negative if the file cannot be opened
saveFile:
    move $t8, $a1
    move $t9, $a2
    li   $a1, 1            # 1 = write (created if missing, replaced if present)
    li   $a2, 0
    li   $v0, 13
    syscall
    bltz $v0, save_done
    nop
    move $t7, $v0
    move $a0, $t7
    move $a1, $t8
    move $a2, $t9
    li   $v0, 15           # write
    syscall
    move $t6, $v0
    move $a0, $t7
    li   $v0, 16
    syscall
    move $v0, $t6
save_done:
    jr   $ra
    nop
