package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

const (
	ringNodes = 1000
	tcpConns  = 50
)

var (
	ringHops  = 200000
	tcpRounds = 1000
	execRuns  = 200
	cpuRounds = 200000
)

func fnv(h uint64, b []byte) uint64 {
	for _, c := range b {
		h ^= uint64(c)
		h *= 1099511628211
	}
	return h
}

type token struct {
	hops int
	sum  uint64
}

func ring() uint64 {
	chans := make([]chan token, ringNodes)
	for i := range chans {
		chans[i] = make(chan token)
	}
	done := make(chan token)
	for i := 0; i < ringNodes; i++ {
		go func(id int) {
			for t := range chans[id] {
				t.hops++
				t.sum = t.sum*1315423911 + uint64(id+1)
				if t.hops == ringHops {
					done <- t
					return
				}
				chans[(id+1)%ringNodes] <- t
			}
		}(i)
	}
	chans[0] <- token{}
	t := <-done
	return t.sum ^ uint64(t.hops)
}

func tcp() uint64 {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen:", err)
		os.Exit(1)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				io.Copy(c, c)
			}(c)
		}
	}()
	var wg sync.WaitGroup
	sums := make([]uint64, tcpConns)
	for i := 0; i < tcpConns; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			c, err := net.Dial("tcp", ln.Addr().String())
			if err != nil {
				fmt.Fprintln(os.Stderr, "dial:", err)
				os.Exit(1)
			}
			defer c.Close()
			out := make([]byte, 16)
			in := make([]byte, 16)
			var h uint64 = 14695981039346656037
			for r := 0; r < tcpRounds; r++ {
				binary.LittleEndian.PutUint64(out, uint64(id))
				binary.LittleEndian.PutUint64(out[8:], uint64(r)*2654435761)
				if _, err := c.Write(out); err != nil {
					fmt.Fprintln(os.Stderr, "write:", err)
					os.Exit(1)
				}
				if _, err := io.ReadFull(c, in); err != nil {
					fmt.Fprintln(os.Stderr, "read:", err)
					os.Exit(1)
				}
				if !bytes.Equal(in, out) {
					fmt.Fprintln(os.Stderr, "echo mismatch")
					os.Exit(1)
				}
				h = fnv(h, in)
			}
			sums[id] = h
		}(i)
	}
	wg.Wait()
	ln.Close()
	var total uint64
	for _, s := range sums {
		total += s
	}
	return total
}

func execs() uint64 {
	var h uint64 = 14695981039346656037
	for i := 0; i < execRuns; i++ {
		out, err := exec.Command("/bin/echo", "hello", fmt.Sprint(i)).Output()
		if err != nil {
			fmt.Fprintln(os.Stderr, "echo:", err)
			os.Exit(1)
		}
		h = fnv(h, out)
	}
	for i := 0; i < execRuns; i++ {
		cmd := exec.Command("sh", "-c", "cat | tr a-z A-Z")
		cmd.Stdin = bytes.NewReader([]byte(fmt.Sprintf("hello pipe %d\n", i)))
		out, err := cmd.Output()
		if err != nil {
			fmt.Fprintln(os.Stderr, "pipe:", err)
			os.Exit(1)
		}
		h = fnv(h, out)
	}
	return h
}

func cpu() uint64 {
	var b [32]byte
	for i := 0; i < cpuRounds; i++ {
		b = sha256.Sum256(b[:])
	}
	return binary.LittleEndian.Uint64(b[:8])
}

var sections = []struct {
	name string
	run  func() uint64
}{{"ring", ring}, {"tcp", tcp}, {"exec", execs}, {"cpu", cpu}}

func main() {
	want := "all"
	if len(os.Args) > 1 {
		want = os.Args[1]
	}
	if len(os.Args) > 2 {
		d, err := strconv.Atoi(os.Args[2])
		if err != nil || d < 1 {
			fmt.Fprintln(os.Stderr, "usage: gobench [all|ring|tcp|exec|cpu] [divisor]")
			os.Exit(2)
		}
		ringHops = max(ringHops/d, 1)
		tcpRounds = max(tcpRounds/d, 1)
		execRuns = max(execRuns/d, 1)
		cpuRounds = max(cpuRounds/d, 1)
	}
	ran := false
	for _, s := range sections {
		if want != "all" && want != s.name {
			continue
		}
		ran = true
		t0 := time.Now()
		sum := s.run()
		fmt.Printf("%s %016x\n", s.name, sum)
		fmt.Fprintf(os.Stderr, "%s ms %.3f\n", s.name, float64(time.Since(t0).Microseconds())/1000)
	}
	if !ran {
		fmt.Fprintln(os.Stderr, "usage: gobench [all|ring|tcp|exec|cpu] [divisor]")
		os.Exit(2)
	}
}
