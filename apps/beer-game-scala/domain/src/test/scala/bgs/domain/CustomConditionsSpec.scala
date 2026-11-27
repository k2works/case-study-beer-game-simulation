package bgs.domain

import munit.FunSuite

/** カスタム条件（AC1.1.3・AC1.1.4）。範囲外の値はすべて集めて返し、設定の種別は値から導出する。 */
class CustomConditionsSpec extends FunSuite:

  private val demand = List.fill(12)(4)

  private def custom(conditions: CustomConditions) =
    GameSettings.custom(12, demand, CommitMode.Manual, conditions)

  private val none = CustomConditions(Map.empty, None, None, None, None, None, None, None)

  test("[AC1.1.3] すべて省略した条件は、キットの値のまま。変更した項目は無い") {
    val settings = custom(none).fold(e => fail(e.toString), identity)
    assertEquals(settings.changedFields, Nil)
    assertEquals(settings.kind, SettingsKind.Kit)
  }

  test("[AC1.1.3・1.1.4] 変えた項目だけが、変更した項目として、決まった順に示される") {
    val conditions = none.copy(
      initialInventory = Map(Role.Retailer -> 20),
      orderDelayWeeks = Some(3),
      holdingCostMinor = Some(80),
      disclosurePolicy = Some(DisclosurePolicy.None)
    )
    val settings = custom(conditions).fold(e => fail(e.toString), identity)
    assertEquals(
      settings.changedFields,
      List(
        SettingsField.InitialInventory,
        SettingsField.OrderDelay,
        SettingsField.HoldingCost,
        SettingsField.Disclosure
      )
    )
    assertEquals(settings.kind, SettingsKind.Custom)
    assertEquals(settings.initial.inventory(Role.Retailer), Units.trusted(20))
    assertEquals(settings.delays.order, Delay(3))
    assertEquals(settings.costPolicy.holding, Money.trusted(80))
  }

  test("[AC1.1.3] キットの値と同じ値を指定しても、変更とは数えない") {
    val settings =
      custom(none.copy(shipmentDelayWeeks = Some(2), initialInventory = Map(Role.Retailer -> 12)))
        .fold(e => fail(e.toString), identity)
    assertEquals(settings.changedFields, Nil)
  }

  test("[AC1.1.4] 範囲外の値は、対象と修正内容つきで、すべて集めて返す") {
    val conditions = none.copy(
      initialInventory = Map(Role.Retailer -> 1001),
      shipmentDelayWeeks = Some(0),
      holdingCostMinor = Some(-1),
      backlogCostMinor = Some(100001),
      initialFlow = Some(1001)
    )
    val fields = custom(conditions)
      .fold(_.toNonEmptyList.toList, _ => Nil)
      .collect { case ValidationError.ConditionOutOfRange(field, _) => field }
    assertEquals(
      fields.toSet,
      Set(
        "initialInventory",
        "shipmentDelayWeeks",
        "holdingCostMinor",
        "backlogCostMinor",
        "initialFlow"
      )
    )
  }

  test("[AC1.1.4] 遅延は 1〜8 週。境界の 1 と 8 は有効、0 と 9 は無効") {
    List(1, 8).foreach(n => assert(custom(none.copy(orderDelayWeeks = Some(n))).isValid, s"$n"))
    List(0, 9).foreach(n => assert(custom(none.copy(orderDelayWeeks = Some(n))).isInvalid, s"$n"))
  }

  test("[AC1.1.2] 条件が正しくても、最終週・需要系列の誤りは一緒に返す") {
    val errors = GameSettings
      .custom(51, List(1001), CommitMode.Manual, none.copy(shipmentDelayWeeks = Some(0)))
      .fold(_.toNonEmptyList.toList, _ => Nil)
    assert(errors.exists {
      case ValidationError.ConditionOutOfRange("shipmentDelayWeeks", _) => true; case _ => false
    })
    assert(errors.exists { case ValidationError.WeekOutOfRange(_, _) => true; case _ => false })
  }
