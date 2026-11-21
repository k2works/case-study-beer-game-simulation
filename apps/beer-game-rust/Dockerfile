# beer-game-rust の実行イメージ（設計: architecture-infrastructure の RI1・RI3・RI4）。
# ビルド: docker build -t beer-game-rust apps/beer-game-rust
# 実行イメージは、シェルを持たない distroless（cc。非 root）。HEALTHCHECK は、バイナリの `healthcheck` サブコマンド（RI3）。
# 版は、ビルドイメージを rust-toolchain.toml（1.97.1）に合わせる。依存のビルドを別の層にして、キャッシュを効かせる。

FROM rust:1.97.1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
RUN cargo build --release --locked -p beergame-app && \
    cp target/release/beergame-app /beergame-app

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /beergame-app /beergame-app
ENV PORT=8080
EXPOSE 8080
USER nonroot
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 CMD ["/beergame-app", "healthcheck"]
ENTRYPOINT ["/beergame-app"]
CMD ["api"]
