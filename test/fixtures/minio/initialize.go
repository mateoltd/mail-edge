package main

import (
    "context"
    "fmt"
    "os"
    "time"
    "github.com/minio/minio-go/v7"
    "github.com/minio/minio-go/v7/pkg/credentials"
)

func main() {
    if err := initialize(); err != nil {
        // Endpoint responses can contain credentials; emit only a stable failure.
        fmt.Fprintln(os.Stderr, "local storage initialization failed")
        os.Exit(1)
    }
}

func initialize() error {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    client, err := minio.New("minio:9000", &minio.Options{Creds: credentials.NewStaticV4(os.Getenv("MINIO_ROOT_USER"), os.Getenv("MINIO_ROOT_PASSWORD"), ""), Secure: false})
    if err != nil { return err }
    const bucket = "mail-edge-reference"
    exists, err := client.BucketExists(ctx, bucket)
    if err != nil { return err }
    if !exists { if err := client.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil { return err } }
    if err := client.EnableVersioning(ctx, bucket); err != nil { return err }
    versioning, err := client.GetBucketVersioning(ctx, bucket)
    if err != nil { return err }
    if !versioning.Enabled() { return fmt.Errorf("versioning not enabled") }
    fmt.Println("local storage initialized with versioning")
    return nil
}
