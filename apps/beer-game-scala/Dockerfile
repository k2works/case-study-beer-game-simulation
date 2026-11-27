# 本番用イメージ（マルチステージ）。B14。
# ビルド: docker build -t beer-game-scala apps/beer-game-scala
# 起動:   docker run ... beer-game-scala [api|migrate|retention|verify]（既定 api）
#         migrate  PostgreSQL にマイグレーションを適用して終了（デプロイの一部として、アプリの起動前に 1 回限り）
#         retention 保持期限後の削除の掃引を 1 回行って終了（再試行をやめたゲームがあれば 1）
#         verify   ストリームの整合を検査して終了（不一致があれば 1。日次）
#         設定の誤りは、項目名だけをログに出して終了コード 78。不明なモードは 64。
# 設定（環境変数）: APP_ENV・PORT・DB_URL・DB_USER・DB_PASSWORD・BGS_CREDENTIAL_KEY（秘密情報は Secrets Manager から注入。リポジトリに置かない）

# ---- ビルド: JDK 25 + sbt。依存の JAR を target/dist/lib に集める（`sbt app/dist`）----
FROM eclipse-temurin:25-jdk-noble AS build
ARG SBT_VERSION=1.13.1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/sbt/sbt/releases/download/v${SBT_VERSION}/sbt-${SBT_VERSION}.tgz" | tar -xz -C /opt
ENV PATH="/opt/sbt/bin:${PATH}"
WORKDIR /src
COPY . .
RUN sbt -batch app/dist

# ---- 本番用（最後のステージ）: JRE 25 と、ビルド済みの JAR だけ ----
FROM eclipse-temurin:25-jre-noble AS runtime
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=build /src/app/target/dist/lib ./lib
# ヒープはコンテナのメモリの割合で指定し（初期案 70%。測定で決める）、メモリ不足ではプロセスを終了させる。
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=70 -XX:+ExitOnOutOfMemoryError"
USER app
EXPOSE 8080
# /api/v1/ready が 200 のときだけ healthy。curl・wget は実行イメージに無いので、bash の /dev/tcp で HTTP を送る。
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${PORT:-8080} && printf 'GET /api/v1/ready HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && head -n1 <&3 | grep -q ' 200 '"]
ENTRYPOINT ["java", "-cp", "/app/lib/*", "bgs.app.Main"]
CMD ["api"]
