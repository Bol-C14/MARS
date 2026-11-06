# 读写虚拟文件（syscall 13 打开、14 读、15 写、16 关闭）。
# 文件是工程里的文本文件，不会访问电脑上的文件。

.text
.globl loadFile
# loadFile：$a0 = 文件名，$a1 = 缓冲区，$a2 = 缓冲区大小
# 返回 $v0 = 读到的字节数（后面补一个 \0），打不开时为负数
loadFile:
    move $t8, $a1          # 记下缓冲区
    move $t9, $a2          # 记下大小
    li   $a1, 0            # 0 = 只读
    li   $a2, 0
    li   $v0, 13           # 打开：$v0 = 文件描述符
    syscall
    bltz $v0, load_done    # 打不开：把负数原样返回
    nop
    move $t7, $v0          # $t7 = 文件描述符
    move $a0, $t7
    move $a1, $t8
    addiu $a2, $t9, -1     # 留一个字节给结尾的 \0
    li   $v0, 14           # 读：$v0 = 读到的字节数
    syscall
    move $t6, $v0
    bgez $t6, read_ok
    nop
    li   $t6, 0            # 读出错就当作空文件
read_ok:
    addu $t5, $t8, $t6
    sb   $zero, 0($t5)     # 在读到的内容后面补 \0
    move $a0, $t7
    li   $v0, 16           # 关闭
    syscall
    move $v0, $t6
load_done:
    jr   $ra
    nop

.globl saveFile
# saveFile：$a0 = 文件名，$a1 = 要写的内容，$a2 = 字节数
# 返回 $v0 = 写入的字节数，打不开时为负数
saveFile:
    move $t8, $a1
    move $t9, $a2
    li   $a1, 1            # 1 = 写入（没有就新建，有就覆盖）
    li   $a2, 0
    li   $v0, 13
    syscall
    bltz $v0, save_done
    nop
    move $t7, $v0
    move $a0, $t7
    move $a1, $t8
    move $a2, $t9
    li   $v0, 15           # 写
    syscall
    move $t6, $v0
    move $a0, $t7
    li   $v0, 16
    syscall
    move $v0, $t6
save_done:
    jr   $ra
    nop
