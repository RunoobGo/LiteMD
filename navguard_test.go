package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// navGuard 是"永不白屏卡死"的最后一道防线：预览链接只要有任何一处漏网
// （中键、右键新窗口、未来新代码引入的裸 <a>），WebView 就地导航到
// http://wails.localhost/<路径> 时，assetserver 的 404 必须被改写为
// 302 回首页并携带 ?nav=<原路径>，而不是把整个前端 SPA 卸载掉。
func TestNavGuardRedirectsMissingAssets(t *testing.T) {
	next := http.NotFoundHandler()
	h := navGuard(next)

	req := httptest.NewRequest(http.MethodGet, "/%E6%96%87%E6%A1%A3%E5%90%8D", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("404 未被重定向: code=%d", rec.Code)
	}
	loc, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatalf("Location 解析失败: %v", err)
	}
	if loc.Path != "/" {
		t.Fatalf("应重定向到 /, 得到 %s", loc.Path)
	}
	// httptest.NewRequest 会把 percent 编码解码进 r.URL.Path，
	// 因此 nav 参数即前端可直接展示的原始路径（含中文）
	if got := loc.Query().Get("nav"); got != "/文档名" {
		t.Fatalf("nav 参数应携带原始(解码后)路径, 得到 %q", got)
	}
}

func TestNavGuardPassthrough(t *testing.T) {
	hits := 0
	okHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ui"))
	})
	h := navGuard(okHandler)

	// 正常资源：原样透传，且响应头/体不被破坏
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/main-abc123.js", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "ui" || hits != 1 {
		t.Fatalf("正常资源被改写: code=%d body=%q hits=%d", rec.Code, rec.Body.String(), hits)
	}

	// 首页：透传
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK || hits != 2 {
		t.Fatalf("首页被改写: code=%d hits=%d", rec.Code, hits)
	}

	// Wails 内建端点（/wails/runtime 等）：即使 next 返回 404 也不能重定向，
	// 否则会打断前端与 Go 的运行时通信。测试桩返回 200，断言"未发生重定向"。
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/wails/runtime.js", nil))
	if rec.Code == http.StatusFound || hits != 3 {
		t.Fatalf("/wails/ 应透传: code=%d hits=%d", rec.Code, hits)
	}

	// 非 GET 请求（如 WebSocket 升级）：透传
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/whatever", strings.NewReader("")))
	if rec.Code == http.StatusFound || hits != 4 {
		t.Fatalf("非 GET 应透传: code=%d hits=%d", rec.Code, hits)
	}
}
