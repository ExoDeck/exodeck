package netutil

import "testing"

func TestIsLocalhostHost(t *testing.T) {
	valid := []string{
		"localhost",
		"LOCALHOST",
		"localhost:8000",
		"LOCALHOST:8000",
		"127.0.0.1",
		"127.0.0.1:8000",
		"127.0.1.1:65535",
		"[::1]",
		"[::1]:8000",
		"[0:0:0:0:0:0:0:1]:1",
	}
	for _, host := range valid {
		if !IsLocalhostHost(host) {
			t.Errorf("IsLocalhostHost(%q) = false, want true", host)
		}
	}

	invalid := []string{
		"",
		"   ",
		"evil.com",
		"evil.com:8000",
		"localhost.evil.com",
		"localhost.evil.com:8000",
		"notlocalhost:8000",
		"192.168.1.1",
		"192.168.1.1:8000",
		"0.0.0.0:8000",
		"::1",
		"[::1",
		"[]",
		"[::1]extra",
		"[::1]:",
		"[::1]:0",
		"[::1]:65536",
		"[::1]:abc",
		"[localhost]",
		"[127.0.0.1]",
		"[::ffff:127.0.0.1]",
		"[fe80::1]",
		"localhost:",
		"localhost:0",
		"localhost:65536",
		"localhost:+8000",
		"localhost:abc",
		"localhost@evil.com",
		"localhost/path",
		`localhost\path`,
		"localhost 8000",
	}
	for _, host := range invalid {
		if IsLocalhostHost(host) {
			t.Errorf("IsLocalhostHost(%q) = true, want false", host)
		}
	}
}

func TestIsLocalhostOrigin(t *testing.T) {
	valid := []string{
		"http://localhost",
		"http://localhost:8000",
		"https://localhost:8443",
		"http://127.0.0.1:8000",
		"https://127.0.0.1",
		"http://[::1]:6274",
		"https://[::1]",
	}
	for _, origin := range valid {
		if !IsLocalhostOrigin(origin) {
			t.Errorf("IsLocalhostOrigin(%q) = false, want true", origin)
		}
	}

	invalid := []string{
		"",
		"null",
		"file://",
		"file:///C:/index.html",
		"ftp://localhost:8000",
		"ws://localhost:8000",
		"https://evil.com",
		"http://evil.com:8000",
		"http://localhost.evil.com:8000",
		"http://localhost:8000/",
		"http://localhost:8000/app",
		"http://user@localhost:8000",
		"http://user:pass@localhost:8000",
		"http://localhost:8000?x=1",
		"http://localhost:8000#frag",
		"http://localhost:8000\n",
		`http://localhost:8000\`,
		"http://[::1",
		"://broken",
	}
	for _, origin := range invalid {
		if IsLocalhostOrigin(origin) {
			t.Errorf("IsLocalhostOrigin(%q) = true, want false", origin)
		}
	}
}
