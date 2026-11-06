# 文字与数字之间的转换。

.text
.globl nextInt
# nextInt：$a0 = 从哪里开始找
# 返回 $v0 = 找到的数，$v1 = 接着读的位置；没有数了时 $v1 = 0
nextInt:
skip:
    lbu  $t0, 0($a0)       # 读一个字符
    beqz $t0, no_number    # 读到 \0：文字结束了
    nop
    addiu $t1, $t0, -48    # 字符 '0' 的编码是 48
    sltiu $t2, $t1, 10     # 是 0–9 的数字时得 1
    bnez $t2, number_start
    nop
    addiu $a0, $a0, 1      # 不是数字：跳过
    j    skip
    nop
number_start:
    li   $v0, 0
digit_loop:
    lbu  $t0, 0($a0)
    addiu $t1, $t0, -48
    sltiu $t2, $t1, 10
    beqz $t2, number_done  # 不是数字了：这个数结束
    nop
    li   $t3, 10
    mul  $v0, $v0, $t3     # 数 = 数 × 10 + 这一位
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
# appendText：$a0 = 写到哪里，$a1 = 以 \0 结尾的文字；返回 $v0 = 写完后的位置
appendText:
    lbu  $t0, 0($a1)
    beqz $t0, append_done
    nop
    sb   $t0, 0($a0)       # 一个字节一个字节地复制
    addiu $a0, $a0, 1
    addiu $a1, $a1, 1
    j    appendText
    nop
append_done:
    sb   $zero, 0($a0)     # 结果始终以 \0 结尾
    move $v0, $a0
    jr   $ra
    nop

.globl appendInt
# appendInt：$a0 = 写到哪里，$a1 = 一个不小于 0 的数；返回 $v0 = 写完后的位置
appendInt:
    addiu $sp, $sp, -12    # 在栈上借 12 个字节放各位数字
    addiu $t2, $sp, 12     # $t2 = 借来的空间的末尾
    move $t4, $t2          # 数字从后往前放：先算出的是个位
    move $t0, $a1
    li   $t1, 10
digits_loop:
    divu $t0, $t1          # 除以 10：余数是最后一位，商是剩下的
    mfhi $t3
    mflo $t0
    addiu $t3, $t3, 48     # 数字 0–9 变成字符 '0'–'9'
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
    addiu $sp, $sp, 12     # 把借来的栈空间还回去
    sb   $zero, 0($a0)
    move $v0, $a0
    jr   $ra
    nop
