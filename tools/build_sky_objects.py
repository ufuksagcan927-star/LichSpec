#!/usr/bin/env python3
"""Build LichSpec's deep-sky and compact-object catalogues.

  web/data/deep_sky.json   galaxies, nebulae and star clusters: every OpenNGC object (NGC, IC, the
                           Messier objects and OpenNGC's addendum: Hyades, Horsehead, Large Magellanic
                           Cloud, ...) except stars, duplicates and non-existent entries, plus the
                           Milky Way supernova remnants (Green 2019), Barnard's dark nebulae and the
                           Sharpless HII regions OpenNGC does not have, with distances, ages, masses
                           and member counts from published catalogues.
  web/data/compact.json    black holes and neutron stars: the ATNF Pulsar Catalogue, the McGill
                           magnetar catalogue, the BlackCAT and WATCHDOG black hole catalogues, and
                           the famous objects in BLACK_HOLES / NEUTRON_STARS below.

Where the numbers come from (nothing is invented here; every value keeps its source key):
  * OpenNGC (Mattia Verga, CC BY-SA 4.0): positions, type, size, magnitudes, Hubble type, radial
    velocity, common names. deep_sky.json is therefore CC BY-SA 4.0 too (THIRD_PARTY_NOTICES.md).
  * Distances, in this order:
      - FAMOUS_DISTANCES below (a few nebulae; each with its paper),
      - objects in the Large / Small Magellanic Cloud: the Clouds' distances (Pietrzyński+ 2019,
        Graczyk+ 2020),
      - open clusters: Hunt & Reffert 2023 (Gaia DR3), else Cantat-Gaudin+ 2020 (Gaia DR2);
        a nebula lit by a cluster takes that cluster's distance (NEBULA_CLUSTER),
      - globular clusters: Baumgardt & Hilker 2018 (distance, mass), else Harris (2010 edition);
        [Fe/H] from Harris,
      - planetary nebulae: Gaia EDR3 parallax of the central star (González-Santamaría+ 2021) when
        it is better than 20%,
      - galaxies: Updated Nearby Galaxy Catalog (Karachentsev+ 2013) within ~11 Mpc, else
        Cosmicflows-4 (Tully+ 2023) by PGC number, else (cz > 3000 km/s only) Hubble's law with
        H0 = 70 km/s/Mpc, marked as an estimate.
  * Supernova remnants, dark nebulae and HII regions that match an OpenNGC object (close centre,
    similar size) only add their catalogue name to it; the others become new objects, with the
    constellation from the IAU boundaries (Roman 1987).
  * Turkish names (TR) are the names used in Turkish astronomy writing; English common names stay as
    search aliases.

Usage:
  python tools/fetch_sky_tables.py --out sky-tables       # VizieR + OpenNGC (needs the internet)
  python tools/build_sky_objects.py --tables sky-tables
"""
import argparse
import csv
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
C_KMS = 299792.458
H0 = 70.0

# ----------------------------------------------------------------------------- sources
SOURCES = {
    "openngc": "OpenNGC (M. Verga), CC BY-SA 4.0 — github.com/mattiaverga/OpenNGC",
    "hr23": "Hunt & Reffert 2023, A&A 673, A114 (Gaia DR3 açık kümeleri)",
    "cg20": "Cantat-Gaudin vd. 2020, A&A 640, A1 (Gaia DR2 açık kümeleri)",
    "bh18": "Baumgardt & Hilker 2018, MNRAS 478, 1520 (küresel küme uzaklık ve kütleleri)",
    "harris": "Harris 1996 (2010 baskısı), AJ 112, 1487 (küresel kümeler)",
    "gs21": "González-Santamaría vd. 2021, A&A 656, A51 (Gaia EDR3 merkez yıldız paralaksı)",
    "ungc": "Karachentsev, Makarov & Kaisina 2013, AJ 145, 101 (yakın galaksiler kataloğu)",
    "green19": "Green 2019, J. Astrophys. Astron. 40, 36 (Samanyolu süpernova kalıntıları; VizieR VII/284)",
    "barnard27": "Barnard 1927, Photographic Atlas of Selected Regions of the Milky Way (karanlık bulutsular; VizieR VII/220A)",
    "sharpless59": "Sharpless 1959, ApJS 4, 257 (HII bölgeleri; VizieR VII/20)",
    "roman87": "Roman 1987, PASP 99, 695 (takımyıldız sınırları; VizieR VI/42)",
    "cf4": "Tully vd. 2023, ApJ 944, 94 (Cosmicflows-4)",
    "hubble": "kırmızıya kaymadan Hubble yasasıyla (H0 = 70 km/s/Mpc), tahmini",
    "lmc": "Pietrzyński vd. 2019, Nature 567, 200 (Büyük Macellan Bulutu: 49,59 kpc)",
    "smc": "Graczyk vd. 2020, ApJ 904, 13 (Küçük Macellan Bulutu: 62,44 kpc)",
    "menten07": "Menten vd. 2007, A&A 474, 515 (Orion Bulutsusu, VLBA paralaksı)",
    "orionb": "Orion B molekül bulutu, ~400 pc (Kounkel vd. 2017, ApJ 834, 142; Zucker vd. 2019, ApJ 879, 125)",
    "trimble73": "Trimble 1973, PASP 85, 579 (Yengeç Bulutsusu)",
    "fesen18": "Fesen vd. 2018, MNRAS 481, 1786 (Kuğu Halkası / Peçe Bulutsusu, Gaia)",
    "kuhn20": "Kuhn vd. 2020, ApJ 899, 128 (Kuzey Amerika ve Pelikan bulutsuları, Gaia)",
    "smith06": "Smith 2006, MNRAS 367, 763 (Karina Bulutsusu)",
    "lada09": "Lada, Lombardi & Alves 2009, ApJ 703, 52 (Kaliforniya molekül bulutu)",
    "atnf": "ATNF Pulsar Kataloğu, Manchester vd. 2005, AJ 129, 1993 (atnf.csiro.au/research/pulsar/psrcat)",
    "mcgill": "McGill Magnetar Kataloğu, Olausen & Kaspi 2014, ApJS 212, 6",
    "blackcat": "BlackCAT, Corral-Santana vd. 2016, A&A 587, A61",
    "watchdog": "WATCHDOG, Tetarenko vd. 2016, ApJS 222, 15",
}

# --------------------------------------------------------------------------- Turkish names
# OpenNGC adı → Türkçe ad. Türk gökbilim yazınında kullanılan adlar; İngilizce adlar aramada kalır.
TR = {
    "NGC1952": "Yengeç Bulutsusu", "NGC6523": "Lagün Bulutsusu", "NGC6705": "Yaban Ördeği Kümesi",
    "NGC6205": "Büyük Herkül Kümesi", "NGC6611": "Kartal Bulutsusu", "IC4703": "Kartal Bulutsusu",
    "NGC6618": "Omega Bulutsusu", "NGC6514": "Trifid Bulutsusu", "IC4715": "Küçük Yay Yıldız Bulutu",
    "NGC6853": "Halter Bulutsusu", "NGC0224": "Andromeda Galaksisi", "NGC0598": "Üçgen Galaksisi",
    "NGC1976": "Orion Bulutsusu", "NGC1982": "De Mairan Bulutsusu", "NGC2632": "Arı Kovanı Kümesi",
    "Mel022": "Ülker", "NGC5194": "Girdap Galaksisi", "NGC6720": "Halka Bulutsusu",
    "NGC5055": "Ayçiçeği Galaksisi", "NGC4826": "Kara Göz Galaksisi", "NGC0650": "Küçük Halter Bulutsusu",
    "NGC3031": "Bode Galaksisi", "NGC3034": "Puro Galaksisi", "NGC5236": "Güney Fırıldak Galaksisi",
    "NGC4486": "Başak A", "NGC3587": "Baykuş Bulutsusu", "NGC5457": "Fırıldak Galaksisi",
    "NGC4594": "Sombrero Galaksisi", "NGC6405": "Kelebek Kümesi", "NGC6475": "Ptolemaios Kümesi",
    "NGC0628": "Hayalet Galaksi", "NGC3628": "Hamburger Galaksisi",
    "NGC7293": "Helix Bulutsusu", "NGC6543": "Kedi Gözü Bulutsusu", "NGC2392": "Eskimo Bulutsusu",
    "NGC3242": "Jüpiter'in Hayaleti", "NGC7009": "Satürn Bulutsusu", "NGC7662": "Mavi Kartopu Bulutsusu",
    "NGC6826": "Göz Kırpan Bulutsu", "NGC3132": "Güney Halka Bulutsusu", "NGC6302": "Kelebek Bulutsusu",
    "NGC0040": "Papyon Bulutsusu", "NGC6537": "Kırmızı Örümcek Bulutsusu",
    "NGC7000": "Kuzey Amerika Bulutsusu", "IC5070": "Pelikan Bulutsusu",
    "NGC2237": "Rozet Bulutsusu", "NGC2238": "Rozet Bulutsusu", "NGC2246": "Rozet Bulutsusu",
    "NGC2244": "Rozet Kümesi", "NGC2264": "Koni Bulutsusu ve Noel Ağacı Kümesi", "NGC2024": "Alev Bulutsusu",
    "B033": "Atbaşı Bulutsusu", "NGC6960": "Batı Peçe Bulutsusu", "NGC6992": "Doğu Peçe Bulutsusu",
    "NGC6995": "Doğu Peçe Bulutsusu", "NGC3372": "Karina Bulutsusu", "NGC2070": "Tarantula Bulutsusu",
    "ESO056-115": "Büyük Macellan Bulutu", "NGC0292": "Küçük Macellan Bulutu",
    "NGC5139": "Omega Centauri", "NGC0104": "47 Tucanae", "NGC0869": "Çift Küme (h Persei)",
    "NGC0884": "Çift Küme (χ Persei)", "C014": "Çift Küme", "NGC4755": "Mücevher Kutusu",
    "NGC3532": "Dilek Kuyusu Kümesi", "IC2602": "Güney Ülkeri", "NGC6888": "Hilal Bulutsusu",
    "NGC7635": "Kabarcık Bulutsusu", "IC1805": "Kalp Bulutsusu", "IC1848": "Ruh Bulutsusu",
    "IC1396": "Fil Hortumu Bulutsusu", "NGC0281": "Pacman Bulutsusu", "NGC1499": "Kaliforniya Bulutsusu",
    "NGC6334": "Kedi Pençesi Bulutsusu", "NGC6357": "Savaş ve Barış Bulutsusu", "NGC1909": "Cadı Başı Bulutsusu",
    "NGC2359": "Thor'un Miğferi", "NGC1435": "Merope Bulutsusu", "NGC1977": "Koşan Adam Bulutsusu",
    "NGC4565": "İğne Galaksisi", "NGC0253": "Heykeltıraş Galaksisi", "NGC5128": "Erboğa A",
    "NGC4038": "Anten Galaksileri", "NGC4039": "Anten Galaksileri", "NGC6822": "Barnard Galaksisi",
    "HCG092": "Stephan Beşlisi", "HCG079": "Seyfert Altılısı", "NGC4631": "Balina Galaksisi",
    "NGC4656": "Hokey Sopası Galaksisi", "Mel111": "Berenis'in Saçı Kümesi", "Cl399": "Askı Kümesi",
    "C041": "Hyadlar", "C099": "Kömür Çuvalı Bulutsusu", "C009": "Mağara Bulutsusu",
    "UGC05470": "Aslan I", "ESO351-030": "Heykeltıraş Cüce Galaksisi", "ESO356-004": "Fırın Cüce Galaksisi",
    "ESO097-013": "Pergel Galaksisi", "NGC6946": "Havai Fişek Galaksisi", "NGC4676": "Fareler Galaksileri",
    "NGC2068": "M78 Bulutsusu", "IC0434": "IC 434 (Atbaşı'nın ardındaki parlak bulutsu)",
    "NGC1275": "Kahraman A", "NGC1316": "Fırın A", "NGC2174": "Maymun Başı Bulutsusu",
    "NGC7023": "İris Bulutsusu", "IC0405": "Alevli Yıldız Bulutsusu", "IC5146": "Koza Bulutsusu",
    "NGC0457": "Baykuş Kümesi", "IC0443": "Denizanası Bulutsusu", "NGC2261": "Hubble'ın Değişen Bulutsusu",
    "NGC6445": "Küçük Mücevher Bulutsusu", "NGC6369": "Küçük Hayalet Bulutsusu",
    "NGC4567": "Siyam İkizleri", "NGC4568": "Siyam İkizleri", "NGC3115": "İğ Galaksisi",
    "NGC2736": "Kalem Bulutsusu", "IC4604": "Rho Ophiuchi Bulutsusu", "NGC6188": "Kenar Bulutsusu",
}
# OpenNGC'de ortak adı olmayan ama bilinen İngilizce adlar (arama için)
EN_EXTRA = {
    "NGC5457": ["Pinwheel Galaxy"], "NGC0628": ["Phantom Galaxy"], "NGC3628": ["Hamburger Galaxy", "Sarah's Galaxy"],
    "NGC3623": ["Leo Triplet"], "NGC3627": ["Leo Triplet"], "NGC6853": ["Apple Core Nebula"],
    "NGC2244": ["Rosette Cluster"], "NGC2264": ["Cone Nebula", "Snowflake Cluster"],
    "NGC4486": ["Virgo A", "M87"], "NGC0221": ["Le Gentil"], "NGC1068": ["Cetus A", "Squid Galaxy"],
    "NGC4258": ["NGC 4258 maser galaxy"], "NGC6656": ["Great Sagittarius Cluster"],
    "NGC7078": ["Great Pegasus Cluster"], "NGC2287": ["Little Beehive"], "NGC3556": ["Surfboard Galaxy"],
    "NGC2068": ["M78"], "NGC6720": ["M57"], "IC0434": ["Horsehead background"],
}

# Green 2019 süpernova kalıntıları (OpenNGC'de olmayanlar): G adı → Türkçe ad
SNR_TR = {
    "G111.7-2.1": "Kraliçe A (Cassiopeia A)", "G4.5+6.8": "Kepler'in süpernovası (SN 1604)",
    "G120.1+1.4": "Tycho'nun süpernovası (SN 1572)", "G263.9-3.3": "Yelken (Vela) süpernova kalıntısı",
    "G74.0-8.5": "Kuğu Halkası", "G260.4-3.4": "Pupa A", "G180.0-1.7": "Simeis 147 (Spagetti Bulutsusu)",
    "G327.6+14.6": "SN 1006 kalıntısı", "G315.4-2.3": "RCW 86 (SN 185)",
    "G1.9+0.3": "G1.9+0.3 (Samanyolu'nun bilinen en genç süpernova kalıntısı)",
    "G39.7-2.0": "W50 (Deniz İneği Bulutsusu, SS 433)", "G0.0+0.0": "Yay A Doğu",
    "G130.7+3.1": "3C 58 (SN 1181)", "G266.2-1.2": "Vela Junior", "G78.2+2.1": "Gama Kuğu süpernova kalıntısı",
    "G205.5+0.5": "Tekboynuz Halkası", "G330.0+15.0": "Kurt Halkası",
}
# Barnard karanlık bulutsuları (OpenNGC'de olmayanlar)
DARK_TR = {
    "B 72": "Yılan Bulutsusu", "B 142": "Barnard'ın E'si (B 142)", "B 143": "Barnard'ın E'si (B 143)",
    "B 86": "Mürekkep Lekesi Bulutsusu", "B 78": "Pipo Bulutsusu (çanak)", "B 59": "Pipo Bulutsusu (B 59)",
    "B 68": "Barnard 68 (Bok küreciği)", "B 150": "Denizatı Bulutsusu",
}
# Sharpless HII bölgeleri (OpenNGC'de olmayanlar)
SH2_TR = {
    "Sh2-276": "Barnard Halkası", "Sh2-264": "Lambda Orionis Halkası", "Sh2-101": "Lale Bulutsusu",
    "Sh2-129": "Uçan Yarasa Bulutsusu", "Sh2-308": "Yunus Kafası Bulutsusu", "Sh2-157": "Istakoz Kıskacı Bulutsusu",
    "Sh2-27": "Zeta Ophiuchi'nin HII bölgesi",
}
# konumu NGC/IC cisminden uzak düşen ünlü Sharpless bölgeleri → OpenNGC (ya da Green) karşılığı
SH2_LINK = {
    "Sh2-25": "NGC6523", "Sh2-30": "NGC6514", "Sh2-49": "NGC6611", "Sh2-117": "NGC7000", "Sh2-220": "NGC1499",
    "Sh2-240": "G180.0-1.7", "Sh2-275": "NGC2238", "Sh2-277": "NGC2024", "Sh2-103": "G74.0-8.5", "Sh2-171": "NGC7822",
}
SH2_EN = {
    "Sh2-276": ["Barnard's Loop"], "Sh2-264": ["Lambda Orionis Ring", "Meissa Ring"], "Sh2-101": ["Tulip Nebula"],
    "Sh2-129": ["Flying Bat Nebula"], "Sh2-308": ["Dolphin Head Nebula"], "Sh2-157": ["Lobster Claw Nebula"],
}

# --------------------------------------------------------------- distances from papers
# OpenNGC adı → (uzaklık pc, hata pc ya da None, kaynak anahtarı)
FAMOUS_DISTANCES = {
    "NGC1976": (414, 7, "menten07"), "NGC1982": (414, 7, "menten07"), "NGC1977": (414, 7, "menten07"),
    "NGC1973": (414, 7, "menten07"), "NGC1975": (414, 7, "menten07"), "NGC1980": (414, 7, "menten07"),
    "NGC1981": (414, 7, "menten07"),
    "B033": (400, None, "orionb"), "NGC2024": (400, None, "orionb"), "NGC2023": (400, None, "orionb"),
    "IC0434": (400, None, "orionb"), "NGC2068": (400, None, "orionb"), "NGC2071": (400, None, "orionb"),
    "NGC2064": (400, None, "orionb"), "NGC2067": (400, None, "orionb"),
    "NGC1952": (2000, 500, "trimble73"),
    "NGC6960": (735, 25, "fesen18"), "NGC6992": (735, 25, "fesen18"), "NGC6995": (735, 25, "fesen18"),
    "NGC6974": (735, 25, "fesen18"), "NGC6979": (735, 25, "fesen18"), "IC1340": (735, 25, "fesen18"),
    "NGC7000": (795, 25, "kuhn20"), "IC5070": (795, 25, "kuhn20"), "IC5067": (795, 25, "kuhn20"),
    "NGC3372": (2300, None, "smith06"),
    "NGC1499": (450, 23, "lada09"),
}
# bir kümenin aydınlattığı bulutsu → küme (uzaklık kümeden)
NEBULA_CLUSTER = {
    "NGC6523": "NGC6530", "NGC6526": "NGC6530",
    "NGC2237": "NGC2244", "NGC2238": "NGC2244", "NGC2239": "NGC2244", "NGC2246": "NGC2244",
    "IC4703": "NGC6611",
}
LMC = (80.894, -69.756, 49590, 540, "lmc")     # merkez ra, dec; uzaklık pc, hata pc
SMC = (13.187, -72.829, 62440, 940, "smc")

# --------------------------------------------------------------- central black holes
# galaksi → (kütle Güneş kütlesi, kaynak)
CENTRAL_BH = {
    "NGC0224": (1.4e8, "Bender vd. 2005, ApJ 631, 280"),
    "NGC0221": (2.5e6, "van den Bosch & de Zeeuw 2010, MNRAS 401, 1770"),
    "NGC4486": (6.5e9, "Event Horizon Telescope 2019, ApJL 875, L6"),
    "NGC3031": (7e7, "Devereux vd. 2003, AJ 125, 1226"),
    "NGC4258": (4.0e7, "Humphreys vd. 2013, ApJ 775, 13"),
    "NGC5128": (5.5e7, "Cappellari vd. 2009, MNRAS 394, 660"),
}

# ------------------------------------------------------------------- black holes
# Kaynaklı değerlerle ünlü kara delikler. Konumlar SIMBAD'dan (MAST ad çözümleyicisi), Gaia BH'ler
# Gaia DR3'ten. m: kütle (Güneş kütlesi), d: uzaklık (pc), z: kırmızıya kayma, pb: yörünge dönemi (gün)
BLACK_HOLES = [
    dict(id="Sgr A*", tr="Yay A*", k="smbh", ra=266.41681662, de=-29.00782497, m=4.297e6, me=0.013e6,
         d=8277, d_e=34, src="GRAVITY İşbirliği 2022, A&A 657, L12",
         alias=["Sagittarius A*", "Sgr A star", "Samanyolu'nun merkezi", "Galaktik merkez"],
         note="Samanyolu'nun merkezindeki süper kütleli kara delik. Çevresinde dolanan yıldızların (S2 vb.) yörüngelerinden tartıldı; Genzel ve Ghez bu çalışmayla 2020 Nobel Fizik Ödülü'nü aldı. İlk görüntüsü 2022'de Olay Ufku Teleskobu ile yayımlandı."),
    dict(id="M87*", tr="M87*", k="smbh", ra=187.70593077, de=12.39112325, m=6.5e9, me=0.7e9,
         d=16.8e6, d_e=0.8e6, src="Event Horizon Telescope 2019, ApJL 875, L6", host="NGC4486",
         alias=["M87 black hole", "Pōwehi", "Başak A kara deliği"],
         note="Görüntüsü çekilen ilk kara delik (Olay Ufku Teleskobu, Nisan 2019). M87 galaksisinin merkezinde; 5.000 ışık yılı uzunluğunda bir madde fıskiyesi (jet) püskürtüyor."),
    dict(id="Cyg X-1", tr="Kuğu X-1", k="bh", ra=299.59031556, de=35.20160681, m=21.2, me=2.2,
         d=2220, d_e=180, pb=5.599829, comp="HDE 226868, mavi süperdev (O9.7 Iab, ~41 Güneş kütlesi)",
         src="Miller-Jones vd. 2021, Science 371, 1046", alias=["Cygnus X-1", "HDE 226868"],
         note="Kara delik olduğu kabul edilen ilk cisim (1971–72). Mavi süperdev yoldaşından madde çekiyor; bu madde ısınıp X-ışını saçıyor."),
    dict(id="V404 Cyg", tr="V404 Kuğu", k="bh", ra=306.01593626, de=33.86721143, m=9.0, me=0.6,
         d=2390, d_e=140, pb=6.4714, comp="K türü alt dev yıldız",
         src="Khargharia vd. 2010, ApJ 716, 1105; Miller-Jones vd. 2009, ApJL 706, L230",
         alias=["V404 Cygni", "GS 2023+338"],
         note="Uzaklığı radyo paralaksıyla doğrudan ölçülen ilk kara delik. 1938, 1989 ve 2015'te büyük patlamalar yaptı."),
    dict(id="A0620-00", tr="A0620-00 (V616 Tekboynuz)", k="bh", ra=95.68559327, de=-0.34563624, m=6.61, me=0.25,
         d=1060, d_e=120, pb=0.32301, comp="K türü cüce yıldız",
         src="Cantrell vd. 2010, ApJ 710, 1127", alias=["V616 Mon", "V616 Monocerotis", "1A 0620-00", "Nova Monocerotis 1975"],
         note="Bilinen en yakın kara deliklerden biri; 1975'teki X-ışını patlamasıyla bulundu."),
    dict(id="Gaia BH1", tr="Gaia BH1", k="bh", ra=262.17120728, de=-0.58109196, m=9.62, me=0.18,
         d=480, d_e=4, pb=185.59, comp="Güneş benzeri G türü yıldız (0,93 Güneş kütlesi)",
         src="El-Badry vd. 2023, MNRAS 518, 1057", gaia="4373465352415301632",
         note="Bilinen en yakın kara delik. X-ışını saçmayan, \"uyuyan\" bir kara delik: Gaia, yoldaş yıldızın gökyüzündeki küçük salınımından buldu."),
    dict(id="Gaia BH2", tr="Gaia BH2", k="bh", ra=207.56971494, de=-59.23900524, m=8.94, me=0.34,
         d=1160, d_e=20, pb=1276.7, comp="kırmızı dev yıldız (1,07 Güneş kütlesi)",
         src="El-Badry vd. 2023, MNRAS 521, 4323", gaia="5870569352746779008",
         note="Gaia'nın yıldız salınımından bulduğu ikinci uyuyan kara delik; yoldaşı 3,5 yılda bir dolanan kırmızı dev."),
    dict(id="Gaia BH3", tr="Gaia BH3", k="bh", ra=294.82786251, de=14.93097961, m=32.70, me=0.82,
         d=590, d_e=6, pb=4253.1, comp="metal fakiri dev yıldız (0,76 Güneş kütlesi)",
         src="Gaia İşbirliği, Panuzzo vd. 2024, A&A 686, L2", gaia="4318465066420528000",
         note="Samanyolu'nda bilinen en büyük kütleli yıldız kökenli kara delik (Güneş'in 33 katı); Gaia DR4 verisini hazırlarken bulundu."),
    dict(id="GRS 1915+105", tr="GRS 1915+105", k="bh", ra=288.798149, de=10.945807, m=12.4, me=2.0,
         d=8600, d_e=2000, pb=33.85, comp="K türü dev yıldız",
         src="Reid vd. 2014, ApJ 796, 2", alias=["V1487 Aql"],
         note="Bir mikrokuasar: ışık hızından hızlıymış gibi görünen fıskiyeleri (görünür ışıktan hızlı hareket) ilk kez Samanyolu'nda bunda görüldü (Mirabel & Rodríguez 1994)."),
    dict(id="MAXI J1820+070", tr="MAXI J1820+070", k="bh", ra=275.09142659, de=7.18535691, m=8.48, me=0.79,
         d=2960, d_e=330, pb=0.68549, comp="K türü cüce yıldız",
         src="Torres vd. 2020, ApJL 893, L37; Atri vd. 2020, MNRAS 493, L81", alias=["ASASSN-18ey"],
         note="2018'deki patlamasında gökyüzünün en parlak X-ışını kaynaklarından biri oldu."),
    dict(id="M33 X-7", tr="M33 X-7", k="bh", ra=23.39221, de=30.53647, m=15.65, me=1.45,
         d=840000, d_e=20000, pb=3.4530, comp="O türü dev yıldız (~70 Güneş kütlesi)",
         src="Orosz vd. 2007, Nature 449, 872", host="NGC0598",
         note="Başka bir galaksideki (Üçgen Galaksisi, M33) yıldız kökenli bir kara delik; yoldaşı onu her 3,45 günde bir örtüyor."),
    dict(id="LMC X-1", tr="LMC X-1", k="bh", ra=84.91178513, de=-69.74320321, m=10.91, me=1.41,
         d=49590, d_e=540, pb=3.9094, comp="O türü dev yıldız",
         src="Orosz vd. 2009, ApJ 697, 573", host="ESO056-115",
         note="Büyük Macellan Bulutu'ndaki, sürekli parlak bir kara delikli X-ışını çifti."),
    dict(id="XTE J1550-564", tr="XTE J1550-564", k="bh", ra=237.74443247, de=-56.47646066, m=9.10, me=0.61,
         d=4380, d_e=500, pb=1.5420, comp="K türü alt dev yıldız",
         src="Orosz vd. 2011, ApJ 730, 75", alias=["V381 Nor"]),
    dict(id="GRO J1655-40", tr="GRO J1655-40", k="bh", ra=253.50059332, de=-39.84576714, m=5.31, me=0.07,
         d=3200, d_e=200, pb=2.6214, comp="F türü alt dev yıldız",
         src="Beer & Podsiadlowski 2002, MNRAS 331, 351; Hjellming & Rupen 1995, Nature 375, 464", alias=["V1033 Sco"]),
    dict(id="TON 618", tr="TON 618", k="smbh", ra=187.10402489, de=31.47711916, m=6.6e10, z=2.219,
         src="Shemmer vd. 2004, ApJ 614, 547 (kütle Hβ çizgi genişliğinden, belirsizliği büyük)",
         alias=["Ton 618"],
         note="Bilinen en büyük kütleli kara deliklerden biri: Güneş'in yaklaşık 66 milyar katı. Bir kuasar: çevresindeki madde diski bütün bir galaksiden yüzlerce kat parlak."),
    dict(id="3C 273", tr="3C 273", k="smbh", ra=187.27791594, de=2.05238823, m=2.6e8, me=1.1e8, z=0.158339,
         src="GRAVITY İşbirliği 2018, Nature 563, 657", alias=["3C273"],
         note="Tanımlanan ilk kuasar (Schmidt 1963) ve gökyüzündeki en parlak kuasar (yaklaşık 12,9 kadir): küçük bir teleskopla görülebilen en uzak cisimlerden."),
]

# ------------------------------------------------------------------ neutron stars
# ATNF'de olan pulsarlar için yalnızca Türkçe ad ve not; diğerleri tam kayıt.
PULSAR_NOTES = {
    "J0534+2200": ("Yengeç Pulsarı", ["Crab Pulsar", "PSR B0531+21"],
                   "1054'te Çinli gökbilimcilerin kaydettiği süpernovadan kalan nötron yıldızı; Yengeç Bulutsusu'nun (M1) ortasında. Saniyede 30 kez dönüyor."),
    "J0835-4510": ("Vela Pulsarı", ["Vela Pulsar", "PSR B0833-45"],
                   "Yelken takımyıldızındaki Vela süpernova kalıntısının içinde; dönüşü zaman zaman aniden hızlanıyor (\"glitch\")."),
    "J0633+1746": ("Geminga", ["Geminga", "PSR B0630+17"],
                   "Radyoda çok sönük, gama ışınında gökyüzünün en parlak kaynaklarından biri; ~300.000 yıl önceki bir süpernovadan kaldı."),
    "J1921+2153": ("PSR B1919+21 (ilk pulsar)", ["PSR B1919+21", "CP 1919", "LGM-1"],
                   "Bulunan ilk pulsar: Jocelyn Bell Burnell ve Antony Hewish, 1967. Düzenli atımları önce şakayla \"Küçük Yeşil Adamlar\" (LGM-1) diye anıldı."),
    "J1915+1606": ("Hulse–Taylor çift pulsarı", ["PSR B1913+16", "Hulse-Taylor pulsar"],
                   "Yörüngesinin küçülmesi kütleçekim dalgalarının ilk dolaylı kanıtı oldu (1993 Nobel Fizik Ödülü)."),
    "J0737-3039A": ("Çift Pulsar (A)", ["Double Pulsar", "PSR J0737-3039"],
                    "Bilinen tek çift pulsar sisteminin hızlı dönen üyesi; genel göreliliğin en sıkı testlerinden birini sağlıyor."),
    "J0737-3039B": ("Çift Pulsar (B)", ["Double Pulsar B"], "Çift Pulsar sisteminin yavaş dönen üyesi."),
    "J1748-2446ad": ("En hızlı dönen pulsar", ["PSR J1748-2446ad", "Terzan 5 ad"],
                     "Bilinen en hızlı dönen nötron yıldızı: saniyede 716 tur. Terzan 5 küresel kümesinde."),
    "J0952-0607": ("PSR J0952-0607", ["Black Widow pulsar J0952"],
                   "Ölçülen en büyük kütleli nötron yıldızı (yaklaşık 2,35 Güneş kütlesi; Romani vd. 2022). Yoldaşını buharlaştıran bir \"kara dul\" pulsarı."),
    "J0740+6620": ("PSR J0740+6620", [], "Kütlesi doğrudan ölçülen en ağır nötron yıldızlarından: 2,08 Güneş kütlesi (Fonseca vd. 2021)."),
    "J0437-4715": ("PSR J0437-4715", [], "Bize en yakın ve en parlak milisaniye pulsarı; beyaz cüce bir yoldaşla dolanıyor."),
    "J1300+1240": ("PSR B1257+12 (ilk ötegezegenler)", ["PSR B1257+12", "Lich"],
                   "Güneş dışında bulunan ilk gezegenler bu pulsarın çevresinde (Wolszczan & Frail 1992). Pulsarın IAU adı \"Lich\"."),
    "J1808-2024": ("SGR 1806-20", ["SGR 1806-20"],
                   "Bir magnetar. 27 Aralık 2004'teki dev patlaması, Güneş Sistemi dışından gelen en güçlü ışınımdı; Dünya'nın üst atmosferini bile etkiledi."),
    "J1935+2154": ("SGR J1935+2154", ["SGR 1935+2154", "FRB 200428"],
                   "Bir magnetar. 28 Nisan 2020'de Samanyolu'ndan gelen ilk hızlı radyo patlamasının (FRB) kaynağı oldu."),
}
NEUTRON_STARS = [
    dict(id="Sco X-1", tr="Akrep X-1", k="ns", ra=244.97945528, de=-15.64028269, d=2800, d_e=300,
         pb=0.787313, comp="düşük kütleli yıldız (V818 Sco)", src="Bradshaw, Fomalont & Geldzahler 1999, ApJL 512, L121",
         alias=["Scorpius X-1", "V818 Sco"],
         note="Güneş dışında bulunan ilk X-ışını kaynağı (Giacconi vd. 1962; 2002 Nobel Fizik Ödülü). Bir nötron yıldızı, yoldaşından madde çekiyor."),
    dict(id="Her X-1", tr="Herkül X-1", k="ns", ra=254.45754589, de=35.34235738, d=6600, d_e=400, P=1.2378, pb=1.70017,
         comp="HZ Her, A–F türü yıldız", src="Reynolds vd. 1997, MNRAS 288, 43", alias=["Hercules X-1", "HZ Her"],
         note="Yoldaşından madde çeken, 1,24 saniyede bir dönen bir X-ışını pulsarı."),
    dict(id="Cen X-3", tr="Erboğa X-3", k="ns", ra=170.31288356, de=-60.62378618, P=4.8, pb=2.087,
         comp="V779 Cen, O türü dev yıldız", src="Giacconi vd. 1971, ApJL 167, L67", alias=["Centaurus X-3", "V779 Cen"],
         note="Bulunan ilk X-ışını pulsarı (Uhuru uydusu, 1971)."),
    dict(id="RX J1856.5-3754", tr="RX J1856.5-3754", k="ns", ra=284.14629, de=-37.90847, d=123, d_e=13,
         src="Walter vd. 2010, ApJ 724, 669",
         note="Yalnız, yoldaşsız ve bize en yakın nötron yıldızlarından biri; yüzeyinden gelen ısıl X-ışınlarıyla parlıyor (\"Muhteşem Yedi\"den biri)."),
    dict(id="Cas A NS", tr="Kraliçe A nötron yıldızı", k="ns", ra=350.86641667, de=58.81177778, d=3400, d_e=300,
         src="Reed vd. 1995, ApJ 440, 706 (uzaklık); Tananbaum 1999, IAU Circ. 7246 (Chandra)", alias=["Cassiopeia A", "Cas A"],
         note="Yaklaşık 350 yıl önce patlayan Kraliçe A süpernovasının kalıntısının ortasındaki genç nötron yıldızı; Chandra'nın ilk görüntüsünde bulundu (1999)."),
    dict(id="GW170817", tr="GW170817 (nötron yıldızı birleşmesi)", k="merger", ra=197.4503542, de=-23.3814842, d=40e6, d_e=8e6,
         src="LIGO/Virgo 2017, PRL 119, 161101; Coulter vd. 2017, Science 358, 1556", host="NGC4993",
         alias=["AT 2017gfo", "kilonova"],
         note="İki nötron yıldızının birleşmesi: kütleçekim dalgasıyla ve ışıkla birlikte görülen ilk olay (17 Ağustos 2017). Patlamada (kilonova) altın ve platin gibi ağır elementler oluştu."),
]


# ----------------------------------------------------------------------------- helpers
def hms(s):
    h, m, x = s.split(":")
    return 15 * (int(h) + int(m) / 60 + float(x) / 3600)


def dms(s):
    sign = -1 if s.strip().startswith("-") else 1
    d, m, x = s.strip().lstrip("+-").split(":")
    return sign * (int(d) + int(m) / 60 + float(x) / 3600)


def num(x):
    try:
        v = float(str(x).strip())
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def sep_deg(ra1, de1, ra2, de2):
    r = math.radians
    c = math.sin(r(de1)) * math.sin(r(de2)) + math.cos(r(de1)) * math.cos(r(de2)) * math.cos(r(ra1 - ra2))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def short(name):
    """OpenNGC adı → okunur ad: NGC0224 → NGC 224, IC0434 → IC 434, Mel022 → Mel 22."""
    m = re.match(r"^(NGC|IC|Mel|HCG|PGC|UGC|ESO|MWSC|Cl|C|B|H)(0*)(\d.*)$", name)
    if not m:
        return name
    cat, rest = m.group(1), m.group(3)
    if cat == "ESO":
        return "ESO " + name[3:]
    rest = rest.replace(" NED", " NED")
    return f"{cat} {rest}"


def key(name):
    """Eşleştirme anahtarı: büyük harf, boşluk/alt çizgi/baştaki sıfırlar yok. Melotte → MEL."""
    s = name.upper().replace("MELOTTE", "MEL").replace("COLLINDER", "CR").replace("TRUMPLER", "TR")
    s = re.sub(r"[\s_]+", "", s)
    return re.sub(r"(?<=[A-Z])0+(?=\d)", "", s)


def r(x, n):
    return None if x is None else round(x, n)


def lookback_gyr(z, h0=67.7, om=0.31):
    """Düz ΛCDM'de geriye bakış zamanı (milyar yıl)."""
    ol, n, t = 1 - om, 4000, 0.0
    for i in range(n):
        zz = z * (i + 0.5) / n
        t += 1 / ((1 + zz) * math.sqrt(om * (1 + zz) ** 3 + ol))
    t *= z / n
    return t * 977.8 / h0


# ----------------------------------------------------------------------------- VizieR
def read_vizier(path):
    """VizieR TSV → {tablo adı: [satır sözlüğü]} (bir dosyada birden çok tablo olabilir)."""
    tables, cur, header, rows, stage = {}, None, None, None, 0
    if not path.exists():
        return tables
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("#Table"):
            cur = line.split()[1].rstrip(":")
            header, rows, stage = None, [], 0
            tables[cur] = rows
            continue
        if line.startswith("#") or cur is None:
            continue
        if not line.strip():
            if header is not None and stage == 3:
                stage = 4                                # tablo bitti
            continue
        if stage == 0:
            header = [h.strip() for h in line.split("\t")]
            stage = 1
        elif stage == 1:
            stage = 2                                    # birimler
            if set(line) <= set("-\t "):
                stage = 3
        elif stage == 2:
            stage = 3                                    # ---- çizgisi
        elif stage == 3:
            rows.append(dict(zip(header, [c.strip() for c in line.split("\t")])))
    return tables


def gname(g):
    """Green adı: G000.0+00.0 → G0.0+0.0."""
    m = re.match(r"^G?\s*(\d+(?:\.\d+)?)\s*([+-])\s*(\d+(?:\.\d+)?)$", g.strip())
    return f"G{float(m.group(1)):.1f}{m.group(2)}{float(m.group(3)):.1f}" if m else g.strip()


def rows_of(tables, fname):
    """Bir VizieR dosyasındaki bütün tabloların satırları."""
    out = []
    for rows in read_vizier(tables / fname).values():
        out += rows
    return out


def col(row, *names):
    """Satırda adlardan ilk dolu olanın değeri (büyük/küçük harf duyarsız)."""
    low = {k.lower(): v for k, v in row.items()}
    for n in names:
        v = low.get(n.lower())
        if v not in (None, ""):
            return v
    return None


def pos(row):
    ra = num(col(row, "_RAJ2000", "RAJ2000", "RA_ICRS", "RAdeg"))
    de = num(col(row, "_DEJ2000", "DEJ2000", "DE_ICRS", "DEdeg"))
    return (ra, de) if ra is not None and de is not None else None


class Grid:
    """Konuma göre hızlı yakın eşleşme (1° hücreler)."""

    def __init__(self, items):
        self.cells = {}
        for it in items:
            ra, de = it["_pos"]
            self.cells.setdefault((int(de + 90), int(ra) % 360), []).append(it)

    def near(self, ra, de, rad_deg):
        out = []
        dd = int(math.ceil(rad_deg)) + 1
        for i in range(int(de + 90) - dd, int(de + 90) + dd + 1):
            span = dd if abs(de) < 80 else 360
            for j in range(int(ra) - span * 2, int(ra) + span * 2 + 1):
                for it in self.cells.get((i, j % 360), ()):
                    s = sep_deg(ra, de, *it["_pos"])
                    if s <= rad_deg:
                        out.append((s, it))
        out.sort(key=lambda x: x[0])
        return out


# ----------------------------------------------------------------------------- OpenNGC
SKIP_TYPES = {"*", "**", "Dup", "NonEx", "Nova", "Other"}


def load_openngc(folder):
    rows = []
    for name in ("NGC.csv", "addendum.csv"):
        with open(folder / name, encoding="utf-8") as fh:
            rows += list(csv.DictReader(fh, delimiter=";"))
    out = []
    for row in rows:
        t = row["Type"]
        if t in SKIP_TYPES and not row.get("M"):
            continue
        if t == "Dup":
            continue
        try:
            ra, de = hms(row["RA"]), dms(row["Dec"])
        except (ValueError, AttributeError):
            continue
        out.append({"row": row, "name": row["Name"], "type": t, "_pos": (ra, de)})
    return out


def messier(row):
    m = (row.get("M") or "").strip()
    return int(m) if m.isdigit() else None


def build_dso(objs, tables):
    by_key = {key(o["name"]): o for o in objs}
    grid = Grid(objs)
    stats = {}

    def setd(o, d, e, src):
        if d and d > 0 and "d" not in o:
            o["d"], o["d_e"], o["ds"] = d, e, src
            stats[src] = stats.get(src, 0) + 1

    # 1) makalelerdeki ünlü bulutsular
    for o in objs:
        f = FAMOUS_DISTANCES.get(o["name"])
        if f:
            setd(o, f[0], f[1], f[2])

    # 2) Macellan Bulutları: OpenNGC verisi HEASARC lmcextobj (7) ya da smcclustrs (6) tablosundan
    # gelen cisimler (yön olarak önlerinde duran 47 Tucanae gibi Samanyolu kümeleri bunlara girmez)
    for o in objs:
        flags = set(re.findall(r":(\d+)", o["row"].get("Sources") or ""))
        cloud = "lmc" if "7" in flags or o["name"] == "ESO056-115" else "smc" if "6" in flags or o["name"] == "NGC0292" else None
        if not cloud:
            continue
        _, _, d, e, src = LMC if cloud == "lmc" else SMC
        if o["name"] not in ("ESO056-115", "NGC0292"):
            o["host"] = "Büyük Macellan Bulutu" if cloud == "lmc" else "Küçük Macellan Bulutu"
        setd(o, d, e, src)

    # 3) açık kümeler: Hunt & Reffert 2023 (Gaia DR3; adlar AllNames sütununda), sonra Cantat-Gaudin 2020
    oc_types = {"OCl", "Cl+N", "*Ass"}

    def oc_match(names, p, rad):
        for nm in names:
            o = by_key.get(key(nm))
            if o is not None:
                return o if o["type"] in oc_types else None
        if p:
            cand = [x for _, x in grid.near(p[0], p[1], rad) if x["type"] in oc_types]
            return cand[0] if cand else None
        return None

    for row in rows_of(tables, "J_A+A_673_A114_clusters.tsv"):
        if (col(row, "Type") or "o") != "o":
            continue
        names = [col(row, "Name") or ""] + (col(row, "AllNames") or "").split(",")
        o = oc_match([n for n in names if n], pos(row), 0.1)
        if o is None:
            continue
        setd(o, num(col(row, "dist50")), None, "hr23")
        if o.get("ds") == "hr23":
            age = num(col(row, "logAge50"))
            n = num(col(row, "N"))
            if age and "age" not in o:
                o["age"], o["age_s"] = round(10 ** age / 1e6, 1), "hr23"
            if n and "n" not in o:
                o["n"] = int(n)
    for row in rows_of(tables, "J_A+A_640_A1_table1.tsv"):
        o = oc_match([col(row, "Cluster") or ""], pos(row), 0.1)
        if o is None:
            continue
        setd(o, num(col(row, "DistPc")), None, "cg20")
        age, n = num(col(row, "AgeNN")), num(col(row, "nbstars07"))
        if age and "age" not in o:
            o["age"], o["age_s"] = round(10 ** age / 1e6, 1), "cg20"
        if n and "n" not in o:
            o["n"] = int(n)

    # bulutsu → kümesi
    for neb, cl in NEBULA_CLUSTER.items():
        o, c = by_key.get(key(neb)), by_key.get(key(cl))
        if o and c and c.get("d") and "d" not in o:
            o["d"], o["d_e"], o["ds"] = c["d"], c.get("d_e"), c["ds"]
            o["lit"] = short(cl)

    # 4) küresel kümeler: uzaklık ve kütle Baumgardt & Hilker 2018, [Fe/H] Harris 2010
    def gc_match(names, p):
        for nm in names:
            o = by_key.get(key(nm)) if nm else None
            if o is not None:
                return o if o["type"] == "GCl" else None
        if p:
            cand = [x for _, x in grid.near(p[0], p[1], 0.05) if x["type"] == "GCl"]
            return cand[0] if cand else None
        return None

    for row in rows_of(tables, "J_MNRAS_478_1520_table2.tsv"):
        o = gc_match([col(row, "Cluster"), col(row, "SimbadName")], pos(row))
        if o:
            d = num(col(row, "Dist"))
            setd(o, d * 1000 if d else None, None, "bh18")
            m = num(col(row, "Mass"))
            if m:
                o["mass"] = m
    for row in rows_of(tables, "VII_202.tsv"):
        o = gc_match([col(row, "ID"), col(row, "Name")], pos(row))
        if not o:
            continue
        feh = num(col(row, "[Fe/H]"))
        if feh is not None:
            o["feh"] = feh
        d = num(col(row, "Rsun"))
        setd(o, d * 1000 if d else None, None, "harris")

    # 5) gezegenimsi bulutsular: merkez yıldızın Gaia EDR3 paralaksı (hata ≤ %20)
    pn = [o for o in objs if o["type"] == "PN"]
    pgrid = Grid(pn)
    cs_pos = {}
    for row in rows_of(tables, "J_A+A_656_A51_tablea1.tsv"):
        if col(row, "PNG") and pos(row):
            cs_pos.setdefault(col(row, "PNG"), pos(row))
    for row in rows_of(tables, "J_A+A_656_A51_tablea2.tsv"):
        p = cs_pos.get(col(row, "PNG"))
        plx, e = num(col(row, "Plx")), num(col(row, "e_Plx"))
        d, lo, hi = num(col(row, "Dist")), num(col(row, "b_Dist")), num(col(row, "B_Dist"))
        if not p or not plx or not e or plx <= 0 or e / plx > 0.2 or not d:
            continue
        cand = pgrid.near(p[0], p[1], 1 / 60)
        if cand:
            setd(cand[0][1], d, (hi - lo) / 2 if lo and hi else None, "gs21")

    # 6) galaksiler
    gal_types = {"G", "GPair", "GTrpl", "GGroup"}
    gals = [o for o in objs if o["type"] in gal_types]
    ggrid = Grid(gals)
    for row in rows_of(tables, "J_AJ_145_101_catalog.tsv"):
        p, d = pos(row), num(col(row, "Dist"))
        if not p or not d:
            continue
        cand = ggrid.near(p[0], p[1], 1.5 / 60)
        if not cand:
            continue
        o = cand[0][1]
        setd(o, d * 1e6, None, "ungc")
        if o.get("ds") == "ungc":
            o["dmeth"] = col(row, "f_Dist")
        for k, c in (("lm", "M26"), ("lhi", "MHI")):
            v = num(col(row, c))
            if v is not None and k not in o:
                o[k] = round(v, 2)
    pgc_index = {}
    for o in gals:
        for m in re.finditer(r"PGC\s*0*(\d+)", o["row"].get("Identifiers") or ""):
            pgc_index.setdefault(int(m.group(1)), o)
    for row in rows_of(tables, "J_ApJ_944_94_table2.tsv"):
        pg, dm = num(col(row, "PGC")), num(col(row, "DM"))
        if pg is None or dm is None:
            continue
        o = pgc_index.get(int(pg))
        if o:
            d = 10 ** ((dm + 5) / 5)
            edm = num(col(row, "e_DM"))
            setd(o, d, d * math.log(10) / 5 * edm if edm else None, "cf4")
    for o in gals:
        v = num(o["row"].get("RadVel"))
        if "d" not in o and v and v > 3000:
            setd(o, v / H0 * 1e6, None, "hubble")
    return stats


# ------------------------------------------------------------------ constellations
def precess_to_b1875(ra, de):
    """J2000 → B1875.0 ekinoksu (IAU 1976 presesyonu, Lieske 1977); Roman 1987 sınırları için."""
    t = (2405889.258550475 - 2451545.0) / 36525.0
    a2r = math.pi / 180 / 3600
    zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t ** 3) * a2r
    z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t ** 3) * a2r
    th = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t ** 3) * a2r
    a0, d0 = math.radians(ra), math.radians(de)
    A = math.cos(d0) * math.sin(a0 + zeta)
    B = math.cos(th) * math.cos(d0) * math.cos(a0 + zeta) - math.sin(th) * math.sin(d0)
    C = math.sin(th) * math.cos(d0) * math.cos(a0 + zeta) + math.cos(th) * math.sin(d0)
    return (math.degrees(math.atan2(A, B) + z)) % 360, math.degrees(math.asin(max(-1.0, min(1.0, C))))


class Constellations:
    """IAU takımyıldız sınırları (Roman 1987, VizieR VI/42): konum → üç harfli kısaltma."""

    def __init__(self, tables):
        self.rows = []
        for row in rows_of(tables, "VI_42.tsv"):
            lo, hi, de = num(col(row, "RA_low")), num(col(row, "RA_up")), num(col(row, "DE_low"))
            c = col(row, "const")
            if None not in (lo, hi, de) and c:
                self.rows.append((de, lo, hi, c.strip()))

    def __call__(self, ra, de):
        a, d = precess_to_b1875(ra, de)
        h = a / 15
        for dl, lo, hi, c in self.rows:            # tablo büyükten küçüğe alt dek sınırına göre sıralı
            if d >= dl and lo <= h < hi:
                return c                           # "UMa", "Ser" (IAU kısaltması)
        return None


# ------------------------------------------- objects OpenNGC does not list (or lists in part)
NEBULA_TYPES = {"HII", "EmN", "Neb", "Cl+N", "RfN", "SNR"}
LINKS = []                                          # (katalog adı, OpenNGC cismi, türü, uzaklık ′) — --links


def extra_objects(objs, tables, constellation):
    """Green 2019 süpernova kalıntıları, Barnard karanlık bulutsuları, Sharpless HII bölgeleri.

    OpenNGC'de karşılığı olan (merkezi yakın ve boyu benzer) cisme yalnızca katalog adı eklenir;
    olmayanlar yeni cisim olur.
    """
    grid = Grid(objs)
    by_key = {key(o["name"]): o for o in objs}
    added, linked = [], {}

    def link(o, ident, src, sep):
        ids = o.setdefault("xids", [])
        if ident not in ids:
            ids.append(ident)
        linked[src] = linked.get(src, 0) + 1
        LINKS.append((ident, o["name"], o["type"], sep))

    def nearest(p, rad_arcmin, types):
        """En yakın uygun cisim ve uzaklığı (yay dakikası)."""
        for s, x in grid.near(p[0], p[1], rad_arcmin / 60):
            if x["type"] in types:
                return s * 60, x
        return None, None

    def new(name, typ, p, size, minor, names, src, extra=None):
        row = {"Name": name, "Type": typ, "MajAx": size, "MinAx": minor, "Common names": ", ".join(names),
               "Const": constellation(*p)}
        o = {"row": row, "name": name, "type": typ, "_pos": p, "src": src}
        if extra:
            o.update(extra)
        added.append(o)
        return o

    for row in rows_of(tables, "VII_284.tsv"):
        p, g = pos(row), col(row, "SNR")
        if not p or not g:
            continue
        g = gname(g)
        maj, mi = num(col(row, "MajDiam")), num(col(row, "MinDiam"))
        names = [n.strip() for n in (col(row, "Names") or "").split(",") if n.strip() and not n.strip().startswith("(")]
        info = {"snr_t": (col(row, "type") or "").strip(), "s1ghz": num(col(row, "S(1GHz)"))}
        size = maj or 1
        s, o = nearest(p, max(3, min(0.3 * size, 15)), {"SNR"})     # Kuğu Halkası, Batı Peçe'ye bağlanmaz
        if o is None:                               # SNR olarak listelenmemişse Green adında geçmeli (IC 443 gibi)
            told = {key(m.group(1) + m.group(2)) for m in re.finditer(r"\b(NGC|IC)\s*(\d+)", col(row, "Names") or "")}
            s, o = next(((d * 60, x) for d, x in grid.near(p[0], p[1], max(3, 0.5 * size) / 60) if key(x["name"]) in told),
                        (None, None))
        if o is not None:
            link(o, g, "green19", s)
            o.update({k: v for k, v in info.items() if v not in (None, "")})
            continue
        tr = SNR_TR.get(g)
        new(g, "SNR", p, maj, mi or maj, names, "green19", dict(info, tr=tr) if tr else info)

    for row in rows_of(tables, "VII_220A_barnard.tsv"):
        p, b = pos(row), col(row, "Barn")
        if not p or not b:
            continue
        bid = f"B {b.strip()}"
        o, s = by_key.get(key("B" + b.strip())), 0.0
        diam = num(col(row, "Diam"))
        if o is None:
            s, o = nearest(p, max(3, 0.3 * (diam or 1)), {"DrkN"})
        if o is not None:
            link(o, bid, "barnard27", s)
            continue
        tr = DARK_TR.get(bid)
        new(bid, "DrkN", p, diam, diam, [], "barnard27", {"tr": tr} if tr else None)

    snr_by_name = {o["name"]: o for o in added}
    for row in rows_of(tables, "VII_20.tsv"):
        p, n = pos(row), col(row, "Sh2")
        if not p or not n:
            continue
        sid = f"Sh2-{n.strip()}"
        diam = num(col(row, "Diam"))
        size = diam or 1
        cur = SH2_LINK.get(sid)
        if cur:                                     # Sharpless'in 1900 konumları kaba: ünlüler elle
            o = by_key.get(key(cur)) or snr_by_name.get(cur)
            s = sep_deg(p[0], p[1], *o["_pos"]) * 60
        else:
            # büyük yaylar (Barnard Halkası gibi) yalnızca merkezleri çok yakınsa bir NGC/IC cismine bağlanır
            s, o = nearest(p, max(5, min(0.4 * size, 30)) if size <= 150 else 5, NEBULA_TYPES)
            if o is None:
                s, o = nearest(p, 2, {"PN"})
        if o is not None:
            link(o, sid, "sharpless59", s)
            continue
        tr = SH2_TR.get(sid)
        extra = {"sh_b": num(col(row, "Bright"))}
        if tr:
            extra["tr"] = tr
        new(sid, "HII", p, diam, diam, SH2_EN.get(sid, []), "sharpless59", extra)
    return added, linked


TYPE_KEEP = {"*": "*", "**": "**", "Other": "Ast"}
# deep_sky.json satırları: sabit sütunlar, ardından (varsa) ek alanlar sözlüğü
COLUMNS = ["id", "t", "ra", "de", "con", "v", "b", "a", "bx", "pa", "sb", "hub", "rv", "d", "d_e", "ds"]


def dso_record(o):
    row = o["row"]
    con = row.get("Const") or None
    rec = {"id": o["name"], "t": TYPE_KEEP.get(o["type"], o["type"]),
           "ra": round(o["_pos"][0], 5), "de": round(o["_pos"][1], 5),
           "con": "Ser" if con in ("Se1", "Se2") else con}          # OpenNGC: Yılan'ın başı / kuyruğu
    for k, f in (("v", "V-Mag"), ("b", "B-Mag"), ("a", "MajAx"), ("bx", "MinAx"), ("pa", "PosAng"), ("sb", "SurfBr")):
        x = num(row.get(f))
        if x is not None:
            rec[k] = round(x, 2) if k not in ("pa",) else round(x)
    if row.get("Hubble"):
        rec["hub"] = row["Hubble"]
    v = num(row.get("RadVel"))
    if v is not None:
        rec["rv"] = round(v)
    for k in ("d", "d_e"):
        if o.get(k):
            rec[k] = float(f"{o[k]:.3g}")
    if o.get("ds"):
        rec["ds"] = o["ds"]
    ext = {}
    m = messier(row)
    if m:
        ext["M"] = m
    if row.get("NGC"):
        ext["ngc"] = [short("NGC" + x.strip()) for x in row["NGC"].split(",") if x.strip()]
    if row.get("IC"):
        ext["ic"] = [short("IC" + x.strip()) for x in row["IC"].split(",") if x.strip()]
    names = [n.strip() for n in (row.get("Common names") or "").split(",") if n.strip()]
    names = [re.sub(r"^the ", "", n) for n in names] + EN_EXTRA.get(o["name"], [])
    if names:
        ext["en"] = list(dict.fromkeys(names))
    if o["name"] in TR:
        ext["tr"] = TR[o["name"]]
    elif o.get("tr"):
        ext["tr"] = o["tr"]
    cat = [x.strip() for x in (row.get("Identifiers") or "").split(",") if x.strip()]
    cald = [int(mm.group(1)) for x in cat for mm in [re.match(r"^C\s*0*(\d+)$", x)] if mm]
    if cald:
        ext["C"] = cald[0]
    elif re.match(r"^C\d{3}$", o["name"]):
        ext["C"] = int(o["name"][1:])
    keep = [x for x in cat if re.match(r"^(Mel|Cr|Tr|Sh2|SH 2|LBN|LDN|Barnard|vdB|Abell|PK|UGC|Arp|Mrk|ESO|Ced|RCW|Gum)", x)][:4]
    for x in o.get("xids", []):                      # Green, Barnard, Sharpless karşılıkları
        if all(key(x) != key(y) for y in keep):
            keep.append(x)
    if keep:
        ext["ids"] = keep
    if row.get("Cstar Names"):
        ext["cs"] = row["Cstar Names"].split(",")[0].strip()
        cv = num(row.get("Cstar V-Mag"))
        if cv is not None:
            ext["csv"] = cv
    for k, out_k in (("age_s", "ags"), ("dmeth", "dmt"), ("lm", "lm"), ("lhi", "lhi"), ("snr_t", "snr"),
                     ("s1ghz", "s1"), ("sh_b", "shb"), ("src", "src")):
        if o.get(k) not in (None, ""):
            ext[out_k] = o[k]
    for k in ("age", "n", "feh", "mass", "host", "lit"):
        if o.get(k) is not None:
            val = o[k]
            if k == "mass":
                val = float(f"{val:.2g}")
            elif k == "feh":
                val = round(val, 2)
            ext[k] = val
    if o["name"] in CENTRAL_BH:
        ext["bh"] = list(CENTRAL_BH[o["name"]])
    out = [rec.get(c) for c in COLUMNS]
    if ext:
        out.append(ext)
    else:
        while out and out[-1] is None:
            out.pop()
    return out


def mag_of(rec):
    return rec[5] if len(rec) > 5 and rec[5] is not None else rec[6] if len(rec) > 6 and rec[6] is not None else 99


# ----------------------------------------------------------------------------- pulsars
def last_digit(v):
    """psrcat.db hatası son basamak cinsinden: "0.53" → 0.01, "1.455E-5" → 1e-8."""
    m = re.match(r"^[+-]?\d*(?:\.(\d*))?(?:[eE]([+-]?\d+))?$", v)
    return 10.0 ** (int(m.group(2) or 0) - len(m.group(1) or "")) if m else None


def sexa(v, hours):
    """"05:34:31.9", "+62:16", "-13" → derece."""
    v = v.strip()
    sign = -1 if v.startswith("-") else 1
    parts = [float(x) for x in v.lstrip("+-").split(":")]
    x = sum(p / 60 ** i for i, p in enumerate(parts))
    return sign * x * (15 if hours else 1)


def ecl2eq(lon, lat):
    """J2000 ekliptik → ekvator (eğiklik 84381.406″)."""
    e = math.radians(84381.406 / 3600)
    lo, la = math.radians(lon), math.radians(lat)
    ra = math.atan2(math.sin(lo) * math.cos(e) - math.tan(la) * math.sin(e), math.cos(lo))
    de = math.asin(math.sin(la) * math.cos(e) + math.cos(la) * math.sin(e) * math.sin(lo))
    return math.degrees(ra) % 360, math.degrees(de)


def companion_mass(pb_d, a1_lts, mp=1.35, incl=60.0):
    """Kütle fonksiyonundan yoldaş kütlesi (ATNF'nin MEDMASS'ı gibi: Mp = 1,35, i = 60°)."""
    t_sun = 4.925490947e-6                                   # G·M☉/c³ (s)
    f = 4 * math.pi ** 2 * a1_lts ** 3 / (t_sun * (pb_d * 86400) ** 2)
    si = math.sin(math.radians(incl))
    lo, hi = 0.0, 200.0
    for _ in range(80):
        mc = (lo + hi) / 2
        if (mc * si) ** 3 / (mp + mc) ** 2 < f:
            lo = mc
        else:
            hi = mc
    return (lo + hi) / 2


def clean_refs(v):
    """"HE[cdt69],HE[fhm+69]" → "HE"; boş girdiler ("OPT:") atılır."""
    items = [re.sub(r"\[.*?\]", "", x).strip() for x in (v or "").split(",")]
    return ",".join(dict.fromkeys(x for x in items if x and not x.endswith(":")))


def pulsar_record(par, jn, ra, de):
    """Ortak pulsar kaydı. par: parametre → (değer, hata ya da None)."""
    def val(k):
        return num(par[k][0]) if k in par else None

    rec = {"id": "PSR " + jn, "k": "psr", "ra": round(ra, 5), "de": round(de, 5), "ds": "atnf"}
    P, Pd, f0, f1 = val("P0"), val("P1"), val("F0"), val("F1")
    if P is None and f0:
        P = 1 / f0
    if Pd is None and f0 and f1 is not None:
        Pd = -f1 / f0 ** 2
    if Pd == 0:
        Pd = None
    if P:
        rec["P"] = float(f"{P:.6g}")
    if Pd is not None:
        rec["Pd"] = float(f"{Pd:.4g}")
    if P and Pd and Pd > 0:                                  # ATNF'nin AGE, BSURF, EDOT tanımları
        rec["age"] = float(f"{P / (2 * Pd) / 3.15576e7:.3g}")                # yıl
        rec["bs"] = float(f"{3.2e19 * math.sqrt(P * Pd):.3g}")              # gauss
        rec["edot"] = float(f"{4 * math.pi ** 2 * 1e45 * Pd / P ** 3:.3g}")  # erg/s
    for k, f in (("dm", "DM"), ("pb", "PB"), ("s14", "S1400"), ("ngl", "NGLT")):
        v = val(f)
        if v is not None:
            rec[k] = float(f"{v:.6g}") if k == "pb" else float(f"{v:.4g}")
    a1 = val("A1")
    if rec.get("pb") and a1:
        rec["mc"] = float(f"{companion_mass(rec['pb'], a1):.3g}")
    # uzaklık: anlamlı (≥ 3σ) paralaks, yoksa bağımsız ölçüm (DIST_A), yoksa DM'den YMW16 modeli
    px = val("PX")
    pxe = None
    if px and "PX" in par and par["PX"][1]:
        e = par["PX"][1]
        pxe = float(e) * last_digit(par["PX"][0]) if e.isdigit() and last_digit(par["PX"][0]) else num(e)
    if px and pxe and px > 0 and px / pxe >= 3:
        rec["d"], rec["dk"] = round(1000 / px), "px"
    elif val("DIST_A"):
        rec["d"], rec["dk"] = round(val("DIST_A") * 1000), "ind"
    elif val("DIST_DM"):
        rec["d"], rec["dk"] = round(val("DIST_DM") * 1000), "dm"
    if "PSRB" in par:
        rec["alias"] = ["PSR " + par["PSRB"][0]]
    for k, f in (("comp", "BINCOMP"), ("ty", "TYPE"), ("as", "ASSOC")):
        v = clean_refs(par[f][0]) if f in par else ""
        if v:
            rec[k] = v
    ref = (par.get("PSRJ") or (None, None))[1] or (par.get("PSRB") or (None, None))[1] or ""
    m = re.search(r"(\d\d)[a-z]?$", ref)                     # keşif yayını: "cwp+17" → 2017
    if m:
        y = int(m.group(1))
        rec["yr"] = 1900 + y if y >= 67 else 2000 + y
    return rec


def read_psrcat(path):
    """ATNF psrcat.db → pulsar kayıtları ve katalog sürümü."""
    if not path.exists():
        return [], None
    out, par, version = [], {}, None

    def flush():
        if "PSRJ" not in par:
            return
        jn = par["PSRJ"][0]
        try:
            if "RAJ" in par and "DECJ" in par:
                ra, de = sexa(par["RAJ"][0], True), sexa(par["DECJ"][0], False)
            elif "ELONG" in par and "ELAT" in par:
                ra, de = ecl2eq(float(par["ELONG"][0]), float(par["ELAT"][0]))
            else:
                return
        except ValueError:
            return
        out.append(pulsar_record(par, jn, ra, de))

    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("#CATALOGUE"):
            version = line.split()[1]
        if line.startswith("@"):
            flush()
            par = {}
            continue
        if not line.strip() or line.startswith("#"):
            continue
        f = line.split()
        if f[0] in par:                                      # aynı parametre birden çok kez: ilki
            continue
        v = " ".join(f[1:]) if f[0] in ("TYPE", "ASSOC", "BINCOMP", "SURVEY") else (f[1] if len(f) > 1 else "")
        if f[0] in ("PSRJ", "PSRB"):
            par[f[0]] = (v, f[2] if len(f) > 2 else None)    # ikinci alan: keşif yayını
            continue
        err = f[2] if len(f) > 2 and re.match(r"^[\d.eE+-]+$", f[2]) else None
        par[f[0]] = (v, err)
    flush()
    return out, version


def vizier_pulsars(tables):
    """VizieR B/psr (2017) → pulsar_record biçimi; psrcat.db yoksa."""
    out = []
    for row in rows_of(tables, "B_psr_psr.tsv"):
        p, name = pos(row), col(row, "PSRJ", "Name")
        if not p or not name:
            continue
        par = {k: (col(row, c), None) for k, c in (("P0", "P0"), ("P1", "P1"), ("F0", "F0"), ("F1", "F1"), ("DM", "DM"),
                                                    ("PB", "PB"), ("S1400", "S1400"), ("BINCOMP", "BINCOMP"),
                                                    ("TYPE", "Type"), ("ASSOC", "Assoc"), ("DIST_DM", "Dist"))
               if col(row, c)}
        rec = pulsar_record(par, name.replace("PSR ", "").strip(), *p)
        if rec.get("d"):
            rec["dk"] = "atnf"
        if num(col(row, "Date")):
            rec["yr"] = int(num(col(row, "Date")))
        if num(col(row, "medM")):
            rec["mc"] = num(col(row, "medM"))
        out.append(rec)
    return out


# ----------------------------------------------------------------------------- compact
def build_compact(tables):
    out, stats = [], {}
    for b in BLACK_HOLES:
        rec = {k: v for k, v in b.items()}
        rec.setdefault("ds", "lit")
        if "z" in rec:
            rec["lb"] = round(lookback_gyr(rec["z"]), 2)
        out.append(rec)
    for n in NEUTRON_STARS:
        out.append(dict(n))
    stats["curated"] = len(out)

    def near_record(ra, de, rad, kinds):
        best = None
        for o in out:
            if o["k"] in kinds and abs(o["de"] - de) < rad * 2:
                s = sep_deg(ra, de, o["ra"], o["de"])
                if s < rad and (best is None or s < best[0]):
                    best = (s, o)
        return best[1] if best else None

    def add_alias(o, name):
        for nm in re.split(r"[;=]", name or ""):           # "N. Mon 1975=V616 Mon"
            nm = nm.strip()
            if not nm or key(nm) == key(o["id"]) or key(nm) == key(o.get("tr") or ""):
                continue
            al = o.setdefault("alias", [])
            if all(key(nm) != key(a) for a in al):
                al.append(nm)

    # ATNF pulsarları: güncel psrcat.db (yoksa VizieR B/psr'nin 2017 kopyası)
    psrs, version = read_psrcat(tables / "psrcat.db")
    if not psrs:
        psrs, version = vizier_pulsars(tables), "VizieR B/psr (2017)"
    stats["atnf_version"] = version
    for rec in psrs:
        jn = rec["id"][4:]
        note = PULSAR_NOTES.get(jn)
        if note:
            tr, extra, rec["note"] = note
            if tr != rec["id"]:
                rec["tr"] = tr
            for a in extra:
                add_alias(rec, a)
        if "AXP" in rec.get("ty", "") or "SGR" in rec.get("as", "").upper():
            rec["k"] = "mag"
        twin = near_record(rec["ra"], rec["de"], 10 / 3600, ("ns",))
        if twin is not None:                         # elle yazılmış nötron yıldızı (RX J1856.5-3754): tek kayıt
            for k, v in rec.items():
                if k not in ("id", "k", "ds", "ra", "de", "alias", "tr", "note") and not (k == "dk" and "d" in twin):
                    twin.setdefault(k, v)
            add_alias(twin, rec["id"])
            for a in rec.get("alias", []):
                add_alias(twin, a)
            continue
        out.append(rec)
    stats["atnf"] = len(psrs)

    # McGill magnetar kataloğu: ATNF'de olanlar magnetar diye işaretlenir, olmayanlar eklenir
    added = 0
    for row in rows_of(tables, "J_ApJS_212_6_table9.tsv"):
        p = pos(row)
        name = col(row, "Name")
        if not p or not name:
            continue
        twin = next((o for o in out if o["k"] in ("psr", "mag") and sep_deg(p[0], p[1], o["ra"], o["de"]) < 1 / 60), None)
        vals = {"P": num(col(row, "Per")), "Pd": num(col(row, "Pdot")), "bs": num(col(row, "B")),
                "edot": num(col(row, "Edot")), "age": num(col(row, "Age")), "d": num(col(row, "Dist"))}
        if vals["Pd"] is not None:
            vals["Pd"] *= 1e-11                           # 10⁻¹¹ s/s
        if vals["bs"] is not None:
            vals["bs"] *= 1e14                            # 10¹⁰ T = 10¹⁴ G
        if vals["edot"] is not None:
            vals["edot"] *= 1e33                          # 10²⁶ W = 10³³ erg/s
        if vals["age"] is not None:
            vals["age"] *= 1e3                            # bin yıl → yıl
        if vals["d"] is not None:
            vals["d"] = round(vals["d"] * 1000)
        lim = {k: (col(row, "l_" + c) or "").strip() for k, c in (("Pd", "Pdot"), ("bs", "B"), ("edot", "Edot"), ("age", "Age"))}
        lim = {k: v for k, v in lim.items() if v and vals.get(k) is not None}
        if twin is not None:                         # magnetar adıyla anılır (4U 0142+61, SGR 1806-20 ...)
            twin["k"] = "mag"
            old = twin["id"]
            twin["id"] = name
            add_alias(twin, old)
            if key(twin.get("tr") or "") == key(name):
                twin.pop("tr")
            for k, v in vals.items():
                if v is not None and k not in twin:
                    twin[k] = float(f"{v:.4g}") if k != "d" else v
                    if k in lim:
                        twin.setdefault("lim", {})[k] = lim[k]
            continue
        rec = {"id": name, "k": "mag", "ra": round(p[0], 5), "de": round(p[1], 5), "ds": "mcgill"}
        rec.update({k: (float(f"{v:.4g}") if k != "d" else v) for k, v in vals.items() if v is not None})
        if lim:
            rec["lim"] = lim
        assoc = col(row, "Assoc")
        if assoc:
            rec["as"] = assoc
        out.append(rec)
        added += 1
    stats["mcgill"] = added

    # BlackCAT (Corral-Santana vd. 2016) ve WATCHDOG (Tetarenko vd. 2016) kara delikli X-ışını çiftleri.
    # Aynı cisim iki katalogda (ya da yukarıdaki elle yazılmış listede) varsa tek kayıt olur: adları
    # takma ad olarak eklenir, boş alanları doldurulur.
    def joined(src_file, extra_file):
        extra = {col(r, "Name"): r for r in rows_of(tables, extra_file) if col(r, "Name")}
        for r in rows_of(tables, src_file):
            yield r, extra.get(col(r, "Name"), {})

    for src, files in (("blackcat", ("J_A+A_587_A61_tablea1.tsv", "J_A+A_587_A61_tablea4.tsv")),
                       ("watchdog", ("J_ApJS_222_15_table12.tsv", "J_ApJS_222_15_table13.tsv"))):
        n = merged = 0
        for row, ex in joined(*files):
            p, name = pos(row), col(row, "Name")
            if not p or not name:
                continue
            vals, names = {}, [name]
            if src == "watchdog":
                confirmed = (col(row, "Type") or "").split(",")[0] == "BH"      # BHC: aday
                vals = {"m": num(col(ex, "mBH1")), "m_hi": num(col(ex, "B_mBH")),
                        "d": num(col(ex, "Dist1")), "d_hi": num(col(ex, "B_Dist")), "pb": num(col(ex, "Porb")),
                        "comp": col(ex, "SpT")}
                if (col(ex, "l_Porb") or "").strip():
                    vals["pb_lim"] = col(ex, "l_Porb").strip()
                names += [x.strip() for x in re.split(r"[;=]", col(row, "OName") or "") if x.strip()]
            else:
                confirmed = (col(row, "f_Name") or "").strip() == "*"           # dinamik olarak doğrulanmış
                vals = {"m": num(col(ex, "M1")), "m_hi": num(col(ex, "M1u")), "d": num(col(row, "Dist")),
                        "pb": num(col(ex, "Porb")), "comp": col(ex, "SpType")}
                if (col(ex, "l_M1") or "").strip() not in ("", "="):
                    vals["m_lim"] = col(ex, "l_M1").strip()
                if (col(row, "l_Dist") or "").strip() in ("<", ">"):
                    vals["d_lim"] = col(row, "l_Dist").strip()
                names += [x.strip("() ") for x in (col(row, "Ctp"), col(ex, "Ctp")) if x and x.strip("() ")]
            for k in ("d", "d_hi"):
                if vals.get(k) is not None:
                    vals[k] = round(vals[k] * 1000)                              # kpc → pc
            if vals.get("pb") is not None:
                vals["pb"] = round(vals["pb"] / 24, 6)                           # saat → gün
            vals = {k: v for k, v in vals.items() if v not in (None, "")}
            twin = near_record(p[0], p[1], 30 / 3600, ("bh",))
            if twin is not None:
                for nm in names:
                    add_alias(twin, nm)
                if twin["ds"] in ("blackcat", "watchdog"):                       # elle yazılmış değerler kalır
                    for k, v in vals.items():
                        twin.setdefault(k, v)
                    if confirmed:
                        twin.pop("cand", None)
                merged += 1
                continue
            rec = {"id": name, "k": "bh", "ra": round(p[0], 5), "de": round(p[1], 5), "ds": src}
            rec.update(vals)
            if not confirmed:
                rec["cand"] = True
            for nm in names[1:]:
                add_alias(rec, nm)
            out.append(rec)
            n += 1
        stats[src] = n
        stats[src + "_merged"] = merged
    return out, stats


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tables", default="sky-tables", help="folder from tools/fetch_sky_tables.py")
    ap.add_argument("--out", default=str(ROOT / "web" / "data"))
    ap.add_argument("--links", action="store_true", help="list the catalogue names given to OpenNGC objects")
    args = ap.parse_args()
    tables = Path(args.tables)
    cons = Constellations(tables)
    if not cons.rows:
        sys.exit(f"{tables}/VI_42.tsv (constellation boundaries) is missing; run tools/fetch_sky_tables.py")
    objs = load_openngc(tables)
    stats = build_dso(objs, tables)
    added, linked = extra_objects(objs, tables, cons)
    filled = 0
    for o in objs:
        if not o["row"].get("Const"):
            o["row"]["Const"] = cons(*o["_pos"])
            filled += 1
    recs = [dso_record(o) for o in objs + added]
    recs.sort(key=mag_of)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    meta = {"sources": SOURCES, "built_from": "tools/build_sky_objects.py",
            "license": "CC BY-SA 4.0 (OpenNGC'den türetildi; THIRD_PARTY_NOTICES.md)"}
    (out / "deep_sky.json").write_text(json.dumps({"meta": meta, "columns": COLUMNS, "objects": recs}, ensure_ascii=False,
                                                  separators=(",", ":")), encoding="utf-8")
    comp, cstats = build_compact(tables)
    for c in comp:
        c["con"] = cons(c["ra"], c["de"])
    (out / "compact.json").write_text(json.dumps({"meta": {"sources": SOURCES, "built_from": "tools/build_sky_objects.py",
                                                           "atnf_version": cstats.get("atnf_version")},
                                                  "objects": comp}, ensure_ascii=False, separators=(",", ":")),
                                      encoding="utf-8")
    print(f"deep_sky.json: {len(recs)} objects ({len(objs)} OpenNGC, {len(added)} added: "
          f"{dict(sorted((t, sum(1 for a in added if a['type'] == t)) for t in {a['type'] for a in added}))}); "
          f"catalogue names linked to OpenNGC objects: {linked}; constellation filled in for {filled}")
    print(f"distances: {stats}")
    if args.links:
        for ident, name, typ, sep in LINKS:
            print(f"  {ident:14s} -> {name:12s} {typ:5s} {sep:5.1f}'")
    print(f"compact.json: {len(comp)} objects: {cstats}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
