package beergame.acceptance

import org.junit.platform.suite.api.IncludeEngines
import org.junit.platform.suite.api.SelectDirectories
import org.junit.platform.suite.api.Suite

/**
 * 受け入れ（@api）の入口。リポジトリの features/ を、Cucumber-JS と共有して 1 か所から読む。
 * グルー（ステップ定義）の場所、タグの絞り込み、実行結果の出力は、junit-platform.properties に書く。
 */
@Suite
@IncludeEngines("cucumber")
@SelectDirectories("../features")
class RunAcceptanceTests
