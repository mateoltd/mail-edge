FROM golang:1.24.6-bookworm@sha256:ab1d1823abb55a9504d2e3e003b75b36dbeb1cbcc4c92593d85a84ee46becc6c AS build
WORKDIR /src
# Source behind RELEASE.2025-07-23T15-54-02Z; no moving image or source tag.
RUN git init . && git remote add origin https://github.com/minio/minio.git \
    && git fetch --depth=1 origin 7ced9663e6a791fef9dc6be798ff24cda9c730ac \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = 7ced9663e6a791fef9dc6be798ff24cda9c730ac
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -mod=readonly -trimpath -buildvcs=false -o /minio .
COPY health.go /tmp/health.go
COPY initialize.go /tmp/initialize.go
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -o /health /tmp/health.go
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -mod=readonly -trimpath -o /initialize /tmp/initialize.go
RUN mkdir /data

FROM scratch
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="7ced9663e6a791fef9dc6be798ff24cda9c730ac" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=build /minio /minio
COPY --from=build /health /health
COPY --from=build /initialize /initialize
COPY --from=build /src/LICENSE /LICENSE
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build --chown=65532:65532 --chmod=0700 /data /data
USER 65532:65532
EXPOSE 9000 9001
ENTRYPOINT ["/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
