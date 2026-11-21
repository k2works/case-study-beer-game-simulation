//! 4 役割と、4 役割がすべて揃うコンテナ。

/// 4 役割。上流から下流の順に並ぶ。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Role {
    Factory,
    Distributor,
    Wholesaler,
    Retailer,
}

impl Role {
    /// 上流から下流の順の全役割。
    pub const ALL: [Role; 4] = [
        Role::Factory,
        Role::Distributor,
        Role::Wholesaler,
        Role::Retailer,
    ];

    /// 発注先（品物の送り手）。工場には無い。
    #[must_use]
    pub const fn upstream(self) -> Option<Role> {
        match self {
            Role::Factory => None,
            Role::Distributor => Some(Role::Factory),
            Role::Wholesaler => Some(Role::Distributor),
            Role::Retailer => Some(Role::Wholesaler),
        }
    }

    /// 受注元（品物の受け手）。小売店には無い（顧客は役割ではない）。
    #[must_use]
    pub const fn downstream(self) -> Option<Role> {
        match self {
            Role::Factory => Some(Role::Distributor),
            Role::Distributor => Some(Role::Wholesaler),
            Role::Wholesaler => Some(Role::Retailer),
            Role::Retailer => None,
        }
    }
}

/// 4 役割すべてに値を持つコンテナ。部分的な対応表を作れないので、「4 役割が揃う」を型で表す。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleMap<A> {
    pub factory: A,
    pub distributor: A,
    pub wholesaler: A,
    pub retailer: A,
}

impl<A> RoleMap<A> {
    #[must_use]
    pub const fn get(&self, role: Role) -> &A {
        match role {
            Role::Factory => &self.factory,
            Role::Distributor => &self.distributor,
            Role::Wholesaler => &self.wholesaler,
            Role::Retailer => &self.retailer,
        }
    }

    /// 上流から下流の順の値。
    #[must_use]
    pub fn values(&self) -> [&A; 4] {
        [
            &self.factory,
            &self.distributor,
            &self.wholesaler,
            &self.retailer,
        ]
    }

    /// 4 役割それぞれに `f` を適用する。
    pub fn map<B>(&self, f: impl Fn(Role, &A) -> B) -> RoleMap<B> {
        RoleMap {
            factory: f(Role::Factory, &self.factory),
            distributor: f(Role::Distributor, &self.distributor),
            wholesaler: f(Role::Wholesaler, &self.wholesaler),
            retailer: f(Role::Retailer, &self.retailer),
        }
    }

    /// 役割から値を作る。
    pub fn of(f: impl Fn(Role) -> A) -> Self {
        RoleMap {
            factory: f(Role::Factory),
            distributor: f(Role::Distributor),
            wholesaler: f(Role::Wholesaler),
            retailer: f(Role::Retailer),
        }
    }
}

impl<A: Clone> RoleMap<A> {
    /// 4 役割に同じ値を入れる。
    #[must_use]
    pub fn all(value: &A) -> Self {
        Self::of(|_| value.clone())
    }
}
