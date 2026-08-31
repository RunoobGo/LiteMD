// Package config 提供 LiteMD 用户配置的加载/保存。
//
// 配置以 JSON 存储于 ~/.litemd/config.json，便于用户备份与迁移。
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Config 描述 LiteMD 的用户配置。
//
// 设计：保持字段最小集。增量字段在迁移时通过 JSON 缺失值兼容（零值默认）。
// 注：窗口尺寸 / KeyMap / CustomCSSPath 曾作为预留字段存在，均无消费方，
// 已移除（2026-08-31）。如需窗口尺寸记忆，应连同前端一起接入。
type Config struct {
	Theme       string   `json:"theme"`       // "auto" | "light" | "dark"
	FontFamily  string   `json:"fontFamily"`  // 编辑器字体
	FontSize    int      `json:"fontSize"`    // 编辑器字号（pt）
	RecentFiles []string `json:"recentFiles"` // 最近文件路径，最多 10 条
}

// Default 返回一份默认配置。首次启动时使用。
func Default() Config {
	return Config{
		Theme:       "auto",
		FontFamily:  "system-ui",
		FontSize:    14,
		RecentFiles: []string{},
	}
}

const fileName = "config.json"

// Store 提供线程安全的配置持久化。
type Store struct {
	mu sync.Mutex
}

// NewStore 创建一个 Store。
func NewStore() *Store { return &Store{} }

// Path 返回配置文件应位于的完整路径。目录不存在时会自动创建。
func (s *Store) Path() (string, error) {
	dir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("home dir: %w", err)
	}
	cfgDir := filepath.Join(dir, ".litemd")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		return "", fmt.Errorf("mkdir %s: %w", cfgDir, err)
	}
	return filepath.Join(cfgDir, fileName), nil
}

// Load 读取并解析配置。文件不存在返回 Default，不会报错。
func (s *Store) Load() (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

// loadLocked 是 Load 的已持锁实现（调用方必须已持有 s.mu）。
func (s *Store) loadLocked() (Config, error) {
	p, err := s.Path()
	if err != nil {
		return Default(), err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Default(), nil
		}
		return Default(), fmt.Errorf("read %s: %w", p, err)
	}
	cfg := Default()
	if err := json.Unmarshal(data, &cfg); err != nil {
		// 配置损坏时降级到默认，避免阻塞用户使用
		return Default(), fmt.Errorf("parse %s: %w (using defaults)", p, err)
	}
	return cfg, nil
}

// Save 将配置写入磁盘，使用临时文件+rename 保证原子性。
func (s *Store) Save(cfg Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked(cfg)
}

// saveLocked 是 Save 的已持锁实现（调用方必须已持有 s.mu）。
func (s *Store) saveLocked(cfg Config) error {
	p, err := s.Path()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	dir := filepath.Dir(p)
	tmp, err := os.CreateTemp(dir, ".litemd-cfg-*.tmp")
	if err != nil {
		return fmt.Errorf("tmp: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write: %w", err)
	}
	// 数据先落盘：避免断电后 rename 的元数据先于数据持久化（与 fileio.WriteText 同源）
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	if err := os.Rename(tmpPath, p); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// Mutate 在同一把锁内完成「读-改-写」全序列并持久化（#5 修复）。
//
// 旧版调用方需自行 Load → 修改 → Save 三步，锁在每步之间释放，
// 并发场景（多标签快速连续保存触发的 PushRecent）存在丢更新窗口：
// 两个 goroutine 同时 Load 到同一份旧配置，后写者覆盖前写者的结果。
// Mutate 保证读到的配置在写回前不会被其他调用方插入修改。
func (s *Store) Mutate(fn func(Config) Config) (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.loadLocked()
	if err != nil {
		return cfg, err
	}
	out := fn(cfg)
	if err := s.saveLocked(out); err != nil {
		return out, err
	}
	return out, nil
}

// PushRecent 将一个文件路径推入 RecentFiles，去重并保留最多 10 条。
func PushRecent(cfg Config, path string, max int) Config {
	if max <= 0 {
		max = 10
	}
	out := make([]string, 0, max)
	out = append(out, path)
	for _, p := range cfg.RecentFiles {
		if p == path {
			continue
		}
		if len(out) >= max {
			break
		}
		out = append(out, p)
	}
	if len(out) > max {
		out = out[:max]
	}
	cfg.RecentFiles = out
	return cfg
}
