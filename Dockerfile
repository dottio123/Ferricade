# The web UI. Its build output, web/dist, is embedded into the binary
# (web/assets.go); the host's web/dist and node_modules never enter the
# build context (.dockerignore).
# Both build stages run natively and Go cross-compiles, so multi-arch builds need no emulation.
FROM --platform=$BUILDPLATFORM node:24 AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
COPY CHANGELOG.md /src/CHANGELOG.md
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist ./web/dist
ARG TARGETOS TARGETARCH VERSION=dev
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-X github.com/dottio123/ferricade/internal/buildinfo.Version=${VERSION}" -o /out/ ./cmd/...

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ferricade /out/rdsim /usr/local/bin/
USER nonroot
ENTRYPOINT ["/usr/local/bin/ferricade"]
CMD ["serve"]
