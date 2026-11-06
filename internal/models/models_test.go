package models_test

import (
	"testing"

	"github.com/ExoDeck/exodeck/internal/models"
)

func TestItemType(t *testing.T) {
	urlStr := "https://example.com"
	pwStr := "secret"
	otpStr := "JBSWY3DPEHPK3PXP"
	encTextStr := "gAAAAA..."
	taskChecked := false

	tests := []struct {
		name     string
		item     models.Item
		expected string
	}{
		{
			name:     "link item",
			item:     models.Item{URL: &urlStr},
			expected: "link",
		},
		{
			name:     "password item with password",
			item:     models.Item{Password: &pwStr},
			expected: "password",
		},
		{
			name:     "password item with otp only",
			item:     models.Item{OTPSecret: &otpStr},
			expected: "password",
		},
		{
			name:     "encrypted note item",
			item:     models.Item{EncText: &encTextStr},
			expected: "enc_note",
		},
		{
			name:     "task item",
			item:     models.Item{TaskChecked: &taskChecked},
			expected: "task",
		},
		{
			name:     "plain note item default",
			item:     models.Item{},
			expected: "note",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.item.ItemType(); got != tc.expected {
				t.Errorf("ItemType() = %q, want %q", got, tc.expected)
			}
		})
	}
}
