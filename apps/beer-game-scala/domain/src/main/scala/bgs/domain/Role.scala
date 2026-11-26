package bgs.domain

import cats.Functor

/** 4 役割。上流から下流の順に並ぶ。 */
enum Role:
  case Factory, Distributor, Wholesaler, Retailer

  /** 発注先（品物の送り手）。工場には無い。 */
  def upstream: Option[Role] = Role.values.toList.lift(ordinal - 1)

  /** 受注元（品物の受け手）。小売店には無い（顧客は役割ではない）。 */
  def downstream: Option[Role] = Role.values.toList.lift(ordinal + 1)

/** 4 役割すべてに値を持つコンテナ。部分的な Map を作れないので、「4 役割が揃う」を型で表す。 */
final case class RoleMap[+A](factory: A, distributor: A, wholesaler: A, retailer: A):

  def apply(role: Role): A = role match
    case Role.Factory     => factory
    case Role.Distributor => distributor
    case Role.Wholesaler  => wholesaler
    case Role.Retailer    => retailer

  /** 上流から下流の順の値。 */
  def values: List[A] = List(factory, distributor, wholesaler, retailer)

  def map[B](f: (Role, A) => B): RoleMap[B] =
    RoleMap(
      f(Role.Factory, factory),
      f(Role.Distributor, distributor),
      f(Role.Wholesaler, wholesaler),
      f(Role.Retailer, retailer)
    )

object RoleMap:
  def all[A](value: A): RoleMap[A] = RoleMap(value, value, value, value)

  def of[A](f: Role => A): RoleMap[A] =
    RoleMap(f(Role.Factory), f(Role.Distributor), f(Role.Wholesaler), f(Role.Retailer))

  given Functor[RoleMap] with
    def map[A, B](fa: RoleMap[A])(f: A => B): RoleMap[B] =
      RoleMap(f(fa.factory), f(fa.distributor), f(fa.wholesaler), f(fa.retailer))
