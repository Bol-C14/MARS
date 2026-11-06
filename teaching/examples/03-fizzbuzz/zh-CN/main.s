# 示例 3 · 循环与分支：FizzBuzz
# 从 1 数到 limit：3 的倍数打印 Fizz，5 的倍数打印 Buzz，两者都是打印 FizzBuzz，其他打印数字本身。
# 试试：打开专注模式看每个分支跳没跳；把 limit 改成别的数。

.data
limit:   .word 15          # 数到几
fizz:    .asciiz "Fizz"
buzz:    .asciiz "Buzz"
newline: .asciiz "\n"

.text
.globl main
main:
    lw   $s1, limit        # $s1 = limit
    li   $s0, 1            # $s0 = i，从 1 开始
    li   $s2, 3
    li   $s3, 5

loop:
    bgt  $s0, $s1, done    # i > limit：数完了
    nop
    li   $t2, 0            # $t2 = 这一行是否已经打印了字

    div  $s0, $s2          # i ÷ 3，余数在 HI
    mfhi $t0
    bnez $t0, not_fizz     # 余数不是 0：不是 3 的倍数
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

    bnez $t2, next_line    # 已经打印了 Fizz 或 Buzz：不打印数字
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
