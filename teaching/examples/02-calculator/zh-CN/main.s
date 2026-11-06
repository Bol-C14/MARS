# 示例 2 · 两个数的计算
# 读入两个整数 a 和 b，打印 a + b、a − b、a × b，以及 a ÷ b 的商和余数。
# 试试：运行时在底部终端输入数字后按 Enter；再试试第二个数输入 0。

.data
askA:   .asciiz "First integer: "
askB:   .asciiz "Second integer: "
sumT:   .asciiz "a + b = "
diffT:  .asciiz "\na - b = "
prodT:  .asciiz "\na * b = "
quotT:  .asciiz "\na / b = "
remT:   .asciiz " remainder "
zeroT:  .asciiz "\nCannot divide by 0"
newline: .asciiz "\n"

.text
.globl main
main:
    li   $v0, 4            # 打印提示
    la   $a0, askA
    syscall
    li   $v0, 5            # $v0 = 5：读一个整数，读到的数放进 $v0
    syscall
    move $s0, $v0          # $s0 = a

    li   $v0, 4
    la   $a0, askB
    syscall
    li   $v0, 5
    syscall
    move $s1, $v0          # $s1 = b

    li   $v0, 4
    la   $a0, sumT
    syscall
    addu $a0, $s0, $s1     # 相加；addu 超出 32 位时不报错
    li   $v0, 1            # $v0 = 1：打印 $a0 里的整数
    syscall

    li   $v0, 4
    la   $a0, diffT
    syscall
    subu $a0, $s0, $s1     # 相减
    li   $v0, 1
    syscall

    li   $v0, 4
    la   $a0, prodT
    syscall
    mul  $a0, $s0, $s1     # 相乘，只保留乘积的低 32 位
    li   $v0, 1
    syscall

    beqz $s1, no_divide    # b 是 0 就不能除
    nop                    # 延迟槽：开启“延迟分支”时这一条总会先执行
    div  $s0, $s1          # 商进 LO，余数进 HI
    li   $v0, 4
    la   $a0, quotT
    syscall
    mflo $a0               # 取出商
    li   $v0, 1
    syscall
    li   $v0, 4
    la   $a0, remT
    syscall
    mfhi $a0               # 取出余数
    li   $v0, 1
    syscall
    j    finish
    nop

no_divide:
    li   $v0, 4
    la   $a0, zeroT
    syscall

finish:
    li   $v0, 4
    la   $a0, newline
    syscall
    li   $v0, 10
    syscall
