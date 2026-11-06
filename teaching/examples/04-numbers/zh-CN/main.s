# 示例 4 · 一个数的几种写法
# 读入一个整数，打印它的十进制、十六进制和 32 位二进制写法，并数出有几个 1。
# 试试：输入 898 或 -1；在 srl 那一行用专注模式“逐位查看”移位；把页脚“数值显示”换成 BIN 对照寄存器。

.data
ask:     .asciiz "Enter an integer: "
decT:    .asciiz "Decimal:  "
hexT:    .asciiz "\nHex:      0x"
binT:    .asciiz "\nBinary:   "
onesT:   .asciiz "\nOne bits: "
digits:  .ascii  "0123456789abcdef"   # 十六进制的 16 个数字，按值排好
newline: .asciiz "\n"

.text
.globl main
main:
    li   $v0, 4
    la   $a0, ask
    syscall
    li   $v0, 5            # 读一个整数
    syscall
    move $s0, $v0          # $s0 = 这个数

    li   $v0, 4
    la   $a0, decT
    syscall
    move $a0, $s0
    li   $v0, 1            # 十进制由 syscall 直接打印
    syscall

# 十六进制：每 4 位是一个数字，从最高的 4 位开始，共 8 个
    li   $v0, 4
    la   $a0, hexT
    syscall
    li   $t0, 28           # 右移的位数：28, 24, …, 0
hex_loop:
    srlv $t1, $s0, $t0     # 把这 4 位移到最低位
    andi $t1, $t1, 0xf     # 只留下最低 4 位：0–15
    la   $t2, digits
    addu $t2, $t2, $t1     # 数字表里第 $t1 个字符的地址
    lbu  $a0, 0($t2)
    li   $v0, 11           # $v0 = 11：打印一个字符
    syscall
    addiu $t0, $t0, -4
    bgez $t0, hex_loop     # 还有没打印的 4 位
    nop

# 二进制：每次取出最高位打印，再把下一位左移上来，同时数 1
    li   $v0, 4
    la   $a0, binT
    syscall
    move $t3, $s0          # 在副本上移位，$s0 保持不变
    li   $t0, 32           # 还剩几位
    li   $s1, 0            # $s1 = 1 的个数
bin_loop:
    srl  $t1, $t3, 31      # 最高位移到最低位：得到 0 或 1
    addu $s1, $s1, $t1
    addiu $a0, $t1, 48     # 0 或 1 加上 48 就是字符 '0' 或 '1'
    li   $v0, 11
    syscall
    sll  $t3, $t3, 1       # 下一位移到最高位
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
