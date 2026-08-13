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
	"time"
)

// Config 描述 LiteMD 的用户配置。
//
// 设计：保持字段最小集。增量字段在迁移时通过 JSON 缺失值兼容（零值默认）。
type Config struct {
	Theme           string    `json:"theme"`           // "auto" | "light" | "dark"
	FontFamily      string    `json:"fontFamily"`      // 编辑器字体
	FontSize        int       `json:"fontSize"`        // 编辑器字号（pt）
	RecentFiles     []string  `json:"recentFiles"`     // 最近文件路径，最多 10 条
	WindowWidth     int       `json:"windowWidth"`     // 上次窗口宽度
	WindowHeight    int       `json:"windowHeight"`    // 上次窗口高度
	KeyMap          string    `json:"keyMap"`          // "default" | "vim" | "emacs"
	CustomCSSPath   string    `json:"customCssPath"`   // 自定义样式路径（可选）
	LastUpdateCheck time.Time `json:"lastUpdateCheck"` // 上次更新检查时间（用于 24h 节流）
}

// Default 返回一份默认配置。首次启动时使用。
func Default() Config {
	return Config{
		Theme:        "auto",
		FontFamily:   "system-ui",
		FontSize:     14,
		RecentFiles:  []string{},
		WindowWidth:  1024,
		WindowHeight: 768,
		KeyMap:       "default",
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
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	if err := os.Rename(tmpPath, p); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
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
