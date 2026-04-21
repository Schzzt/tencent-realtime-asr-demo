package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// Config holds application configuration with a single credential.
type Config struct {
	Port      int    `json:"port"`
	AppID     string `json:"appid"`
	SecretID  string `json:"secret_id"`
	SecretKey string `json:"secret_key"`
}

// ParseConfig reads config from config.json.
func ParseConfig() (*Config, error) {
	configFile := "config.json"
	if len(os.Args) > 1 && os.Args[1] != "--no-browser" && !isFlag(os.Args[1]) {
		configFile = os.Args[1]
	}

	data, err := os.ReadFile(configFile)
	if err != nil {
		return nil, fmt.Errorf("read config file %s: %w", configFile, err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config file: %w", err)
	}

	if cfg.Port == 0 {
		cfg.Port = 8080
	}

	if cfg.AppID == "" || cfg.SecretID == "" || cfg.SecretKey == "" {
		return nil, fmt.Errorf("config missing appid/secret_id/secret_key")
	}

	return &cfg, nil
}

// isFlag checks if a string looks like a command-line flag.
func isFlag(s string) bool {
	return len(s) > 1 && s[0] == '-'
}
