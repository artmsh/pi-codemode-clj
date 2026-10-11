module codemode-clj-vm

go 1.27

require github.com/nooga/let-go v0.0.0

require (
	github.com/zeebo/bencode v1.0.0 // indirect
	github.com/zeebo/xxh3 v1.1.0 // indirect
)

// build.sh clones let-go at the pinned commit and applies safepoint.patch.
replace github.com/nooga/let-go => ./.let-go
