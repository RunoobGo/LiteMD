package main

// app_notify_test.go — 二实例"关联文件待打开"通知的时序测试（审查 P1-8）。
//
// 背景：回调 goroutine（OnSecondInstanceLaunch）与 startup 钩子并发，
// 旧实现的"读 ctx → 置 pending 标记"与 startup 的"写 ctx → 补发"没有在
// 同一把锁下完成，存在丢通知窗口：用户双击 .md，第二个实例把路径塞进
// 队列，主界面却永远收不到事件。
//
// 不变量：无论两者如何交错，
//   发出的通知数 + 仍挂起的通知数 == 通知调用总数（不丢），
//   且每条通知至多被发出一次（不重）。

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
)

func TestNotifyExternalOpen_PendingBeforeStartup(t *testing.T) {
	app := NewApp()
	var emitted int32
	emitEvent = func(context.Context, string) { atomic.AddInt32(&emitted, 1) }
	t.Cleanup(func() { emitEvent = defaultEmitEvent })

	// startup 之前到达：无法直发，必须挂起
	app.notifyExternalOpen()
	if atomic.LoadInt32(&emitted) != 0 {
		t.Fatalf("ctx 未就绪时不应直接发事件, got %d", emitted)
	}
	// startup 后必须补发且只发一次
	app.startup(context.Background())
	if got := atomic.LoadInt32(&emitted); got != 1 {
		t.Fatalf("补发一次, got %d", got)
	}
	// 已就绪：直接发，不再挂起
	app.notifyExternalOpen()
	if got := atomic.LoadInt32(&emitted); got != 2 {
		t.Fatalf("就绪后应直发, got %d", got)
	}
	// 补发过的标记已清空：再 startup 不该重复发
	app.startup(context.Background())
	if got := atomic.LoadInt32(&emitted); got != 2 {
		t.Fatalf("重复 startup 不该重复补发, got %d", got)
	}
}

// notifyStateForTest 读取 ctx 与挂起标记（同一把锁下取快照）。
func (a *App) notifyStateForTest() (context.Context, bool) {
	a.ctxMu.Lock()
	defer a.ctxMu.Unlock()
	return a.ctx, a.pendingNotify
}

// TestNotifyExternalOpen_ConcurrentNoStuck 审查 P1-8 的核心回归点。
//
// 不变量：系统静止（所有 goroutine 已结束）时，不允许出现
// "ctx 已就绪但仍挂着 pendingNotify" —— 那条通知再没有补发时机，
// 前端永远收不到事件（用户双击了 .md，主界面无反应）。
//
// 旧实现里 notifyExternalOpen 先读 ctx（拿到 nil）再置标记，两步之间没有
// 锁；startup 可以插在中间完成"写 ctx + 补发（此时标记还是 false，空转）"，
// 标记随后才被置位 —— 正是这个测试要挡住的状态。
func TestNotifyExternalOpen_ConcurrentNoStuck(t *testing.T) {
	var emitted int32
	emitEvent = func(context.Context, string) { atomic.AddInt32(&emitted, 1) }
	t.Cleanup(func() { emitEvent = defaultEmitEvent })

	for round := 0; round < 300; round++ {
		app := NewApp()
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			app.notifyExternalOpen()
		}()
		go func() {
			defer wg.Done()
			app.startup(context.Background())
		}()
		wg.Wait()

		ctx, pending := app.notifyStateForTest()
		if ctx != nil && pending {
			t.Fatalf("第 %d 轮：ctx 已就绪但通知仍挂起 —— 该通知再无补发时机（P1-8 回归）", round)
		}
	}
	if atomic.LoadInt32(&emitted) == 0 {
		t.Fatal("多轮通知中一次都没发出，通知链路整体失效")
	}
}

// TestNotifyExternalOpen_ManyNotifiersCollapse 多条并发通知允许合并成一次
// 补发：事件只是"去读队列"的信号，文件本身都在 startupFiles 队列里，
// 前端一次消费即可取完。这里确保高压并发下既不死锁也不丢事件。
func TestNotifyExternalOpen_ManyNotifiersCollapse(t *testing.T) {
	app := NewApp()
	var emitted int32
	emitEvent = func(context.Context, string) { atomic.AddInt32(&emitted, 1) }
	t.Cleanup(func() { emitEvent = defaultEmitEvent })

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				app.notifyExternalOpen()
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for j := 0; j < 200; j++ {
			app.startup(context.Background())
		}
	}()
	wg.Wait()

	ctx, pending := app.notifyStateForTest()
	if ctx != nil && pending {
		t.Fatal("高压并发后仍有通知挂起：该通知再无补发时机")
	}
	if atomic.LoadInt32(&emitted) == 0 {
		t.Fatal("高压并发下没有任何事件发出")
	}
}
