package logexport

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const maxFileBytes = 10 << 20

type FileOutput struct {
	Dir  string
	mu   sync.Mutex
	made bool
}

func (f *FileOutput) Name() string { return "file" }

func (f *FileOutput) Deliver(ctx context.Context, recs []Record) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var batch bytes.Buffer
	for _, rec := range recs {
		line, err := json.Marshal(rec)
		if err != nil {
			return fmt.Errorf("marshal log export record: %w", err)
		}
		batch.Write(line)
		batch.WriteByte('\n')
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.made {
		if err := os.MkdirAll(f.Dir, 0750); err != nil {
			return fmt.Errorf("mkdir %s: %w", f.Dir, err)
		}
		f.made = true
	}
	path := filepath.Join(f.Dir, "events.jsonl")
	if info, err := regularFile(path); err != nil {
		return err
	} else if info != nil {
		if info.Size()+int64(batch.Len()) > maxFileBytes {
			if err := rotateFile(path); err != nil {
				return err
			}
		}
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0640)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	if err := file.Chmod(0640); err != nil {
		file.Close()
		return fmt.Errorf("chmod %s: %w", path, err)
	}
	_, writeErr := file.Write(batch.Bytes())
	closeErr := file.Close()
	if writeErr != nil {
		return fmt.Errorf("write %s: %w", path, writeErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close %s: %w", path, closeErr)
	}
	return nil
}

func regularFile(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lstat %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("refusing to write to %s: not a regular file", path)
	}
	return info, nil
}

func rotateFile(path string) error {
	if _, err := regularFile(path + ".10"); err != nil {
		return err
	}
	if err := os.Remove(path + ".10"); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove %s.10: %w", path, err)
	}
	for i := 9; i >= 1; i-- {
		old := fmt.Sprintf("%s.%d", path, i)
		new := fmt.Sprintf("%s.%d", path, i+1)
		if _, err := regularFile(old); err != nil {
			return err
		}
		if _, err := regularFile(new); err != nil {
			return err
		}
		if err := os.Rename(old, new); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("rotate %s: %w", old, err)
		}
	}
	if _, err := regularFile(path); err != nil {
		return err
	}
	if _, err := regularFile(path + ".1"); err != nil {
		return err
	}
	if err := os.Rename(path, path+".1"); err != nil {
		return fmt.Errorf("rotate %s: %w", path, err)
	}
	return nil
}
