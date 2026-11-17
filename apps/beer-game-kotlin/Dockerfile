# 本番用イメージ（マルチステージ）。設計: docs/design/beer-game-kotlin/architecture-infrastructure.md「コンテナと JVM」
# ビルド: docker build -t beer-game-kotlin apps/beer-game-kotlin
# 起動:   docker run ... beer-game-kotlin [api|migrate|retention|rebuild-projections|verify-projections]（既定 api）
#         retention は保持削除の掃引を 1 回行って終了する（B11。終了コード 0、放棄したゲームがあれば 1）。
#         rebuild-projections [ゲーム ID ...] は投影をイベントから作り直す（B12。省くと全ゲーム。終了コード 0、失敗したゲームがあれば 1）。
#         verify-projections は投影の整合を検査する（B12。日次。終了コード 0、不一致があれば 1）。

# ---- ビルド: JDK 25 で Gradle の installDist ----
FROM eclipse-temurin:25-jdk-noble AS build
WORKDIR /src
COPY . .
# H2 のドライバは配布に含めない（app/build.gradle.kts の startScripts と distributions で除外）。
RUN ./gradlew --no-daemon :app:installDist \
    && mkdir -p /out/deps /out/app \
    && cd app/build/install/app/lib \
    && for jar in app.jar application.jar domain.jar adapter-http.jar adapter-persistence.jar; do mv "$jar" /out/app/; done \
    && mv ./*.jar /out/deps/ \
    && cp -r ../bin /out/bin

# ---- 実行: JRE 25 と、ビルド済みの成果物だけ ----
FROM eclipse-temurin:25-jre-noble
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
# 依存の JAR（変更が少ない）とアプリの JAR（変更が多い）を別の層にする。
COPY --from=build /out/bin ./bin
COPY --from=build /out/deps ./lib
COPY --from=build /out/app ./lib
# ヒープはコンテナのメモリの割合で指定し（初期案 70%。測定で決める）、メモリ不足ではプロセスを終了させる。
ENV JAVA_OPTS="-XX:MaxRAMPercentage=70 -XX:+ExitOnOutOfMemoryError"
USER app
EXPOSE 8080
# /api/v1/ready が 200 のときだけ healthy。curl・wget は実行イメージに無いので、bash の /dev/tcp で HTTP を送る。
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${PORT:-8080} && printf 'GET /api/v1/ready HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && head -n1 <&3 | grep -q ' 200 '"]
ENTRYPOINT ["/app/bin/app"]
CMD ["api"]
