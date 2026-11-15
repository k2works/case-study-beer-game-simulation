package beergame.domain

/** 4 役割。上流から下流の順に並ぶ。 */
@Term("役割", "サプライチェーンの 4 つの持ち場（工場・一次卸・二次卸・小売店）。上流から下流の順に並び、発注先は 1 つ上流の役割", "ドメインモデル 用語（beer-game2）")
enum class Role {
    FACTORY,
    DISTRIBUTOR,
    WHOLESALER,
    RETAILER,
    ;

    /** 発注先（品物の送り手）。工場には無い。 */
    val upstream: Role? get() = entries.getOrNull(ordinal - 1)

    /** 受注元（品物の受け手）。小売店には無い（顧客は役割ではない）。 */
    val downstream: Role? get() = entries.getOrNull(ordinal + 1)
}

/** 4 役割すべてに値を持つコンテナ。部分的な Map を作れないので、「4 役割が揃う」を型で表す。 */
data class RoleMap<out A>(
    val factory: A,
    val distributor: A,
    val wholesaler: A,
    val retailer: A,
) {
    operator fun get(role: Role): A =
        when (role) {
            Role.FACTORY -> factory
            Role.DISTRIBUTOR -> distributor
            Role.WHOLESALER -> wholesaler
            Role.RETAILER -> retailer
        }

    /** 上流から下流の順の値。 */
    val values: List<A> get() = listOf(factory, distributor, wholesaler, retailer)

    fun <B> map(f: (Role, A) -> B): RoleMap<B> =
        RoleMap(
            f(Role.FACTORY, factory),
            f(Role.DISTRIBUTOR, distributor),
            f(Role.WHOLESALER, wholesaler),
            f(Role.RETAILER, retailer),
        )

    companion object {
        fun <A> all(value: A): RoleMap<A> = RoleMap(value, value, value, value)

        fun <A> of(f: (Role) -> A): RoleMap<A> =
            RoleMap(f(Role.FACTORY), f(Role.DISTRIBUTOR), f(Role.WHOLESALER), f(Role.RETAILER))
    }
}
