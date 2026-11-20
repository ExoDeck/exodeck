package netutil

import (
	"net"
	"net/url"
	"strconv"
	"strings"
)

func validatePort(port string) bool {
	if port == "" {
		return false
	}
	for i := range len(port) {
		if port[i] < '0' || port[i] > '9' {
			return false
		}
	}
	p, err := strconv.ParseUint(port, 10, 16)
	return err == nil && p >= 1
}

// IsLocalhostHost reports whether a Host header or URL host authority refers to
// localhost / loopback (localhost, 127.0.0.0/8, or [::1]), with an optional valid port.
func IsLocalhostHost(host string) bool {
	if host == "" || strings.ContainsAny(host, "/\\@ \t\r\n") {
		return false
	}

	if strings.HasPrefix(host, "[") {
		closeIdx := strings.IndexByte(host, ']')
		if closeIdx <= 1 {
			return false
		}
		hostname := host[1:closeIdx]
		rest := host[closeIdx+1:]
		if rest != "" {
			if !strings.HasPrefix(rest, ":") || !validatePort(rest[1:]) {
				return false
			}
		}
		ip := net.ParseIP(hostname)
		return ip != nil && ip.To4() == nil && ip.IsLoopback()
	}

	hostname := host
	if strings.Contains(host, ":") {
		h, port, err := net.SplitHostPort(host)
		if err != nil || !validatePort(port) {
			return false
		}
		hostname = h
	}

	if strings.EqualFold(hostname, "localhost") {
		return true
	}
	ip := net.ParseIP(hostname)
	return ip != nil && ip.IsLoopback()
}

// IsLocalhostOrigin reports whether an HTTP Origin header is an http or https
// origin targeting localhost / loopback with no credentials, path, query, or fragment.
func IsLocalhostOrigin(origin string) bool {
	if origin == "" || strings.ContainsAny(origin, " \t\r\n\\?#") {
		return false
	}

	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	if u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	return IsLocalhostHost(u.Host)
}
