package main

// app_close_test.go — OnBeforeClose 关闭守卫（审查 P1-11）的单元测试。
//
// 覆盖三个不变量：
//  1. 无未保存标签 → 直接放行（不弹框）；
//  2. 有未保存标签 → 弹原生确认框，用户"取消"阻止关闭、"退出"放行；
//  3. SetUnsavedCount 负数钳为 0（前端异常值不导致永久弹框）。
//
// confirmCloseDialog 是接缝（与 emitEvent 同套路）：真实实现调
// wailsruntime.MessageDialog，在测试 ctx 下会因拿不到 frontend 而崩溃，
// 故测试中替换为桩函数。

import (
	"context"
	"testing"
)

func TestBeforeClose_AllowWhenClean(t *testing.T) {
	app := NewApp()
	called := false
	confirmCloseDialog = func(context.Context, int) bool {
		called = true
		return true
	}
	t.Cleanup(func() { confirmCloseDialog = defaultConfirmCloseDialog })

	app.SetUnsavedCount(0)
	if prevent := app.beforeClose(context.Background()); prevent {
		t.Fatal("无未保存标签应放行关闭")
	}
	if called {
		t.Fatal("无未保存标签不应弹确认框")
	}
}

func TestBeforeClose_DialogVetoAndConfirm(t *testing.T) {
	app := NewApp()
	app.SetUnsavedCount(3)

	// 用户点"取消"（confirmCloseDialog 返回 false）→ beforeClose 返回 true（阻止）
	confirmCloseDialog = func(_ context.Context, unsaved int) bool {
		if unsaved != 3 {
			t.Fatalf("确认框应收到未保存数 3，实际 %d", unsaved)
		}
		return false // 取消
	}
	if prevent := app.beforeClose(context.Background()); !prevent {
		t.Fatal("用户取消时应阻止关闭")
	}

	// 用户点"退出"（返回 true）→ beforeClose 返回 false（放行）
	confirmCloseDialog = func(context.Context, int) bool { return true }
	if prevent := app.beforeClose(context.Background()); prevent {
		t.Fatal("用户确认退出时应放行关闭")
	}

	t.Cleanup(func() { confirmCloseDialog = defaultConfirmCloseDialog })
}

func TestSetUnsavedCount_ClampsNegative(t *testing.T) {
	app := NewApp()
	app.SetUnsavedCount(-5)
	if got := app.unsaved.Load(); got != 0 {
		t.Fatalf("负数应钳为 0，实际 %d", got)
	}
	// 钳位后关闭行为与干净状态一致：放行且不弹框
	called := false
	confirmCloseDialog = func(context.Context, int) bool {
		called = true
		return true
	}
	t.Cleanup(func() { confirmCloseDialog = defaultConfirmCloseDialog })
	if prevent := app.beforeClose(context.Background()); prevent || called {
		t.Fatal("负数上报后应表现为无未保存：放行且不弹框")
	}
}
