             PGM

             DLTF       FILE(BENCZ1/ITBASICD)
             MONMSG     MSGID(CPF2105)
             CRTDSPF    FILE(BENCZ1/ITBASICD) +
                          SRCFILE(BENCZ1/QDDSSRC) SRCMBR(ITBASICD) +
                          ENHDSP(*YES) RSTDSP(*YES)
             CRTBNDRPG  PGM(BENCZ1/ITBASICR) +
                          SRCFILE(BENCZ1/QRPGLESRC) SRCMBR(ITBASICR)

             DLTF       FILE(BENCZ1/ITWINDOWD)
             MONMSG     MSGID(CPF2105)
             CRTDSPF    FILE(BENCZ1/ITWINDOWD) +
                          SRCFILE(BENCZ1/QDDSSRC) SRCMBR(ITWINDOWD) +
                          ENHDSP(*YES) RSTDSP(*YES)
             CRTBNDRPG  PGM(BENCZ1/ITWINDOWR) +
                          SRCFILE(BENCZ1/QRPGLESRC) SRCMBR(ITWINDOWR)

             DLTF       FILE(BENCZ1/ITMOUSED)
             MONMSG     MSGID(CPF2105)
             CRTDSPF    FILE(BENCZ1/ITMOUSED) +
                          SRCFILE(BENCZ1/QDDSSRC) SRCMBR(ITMOUSED) +
                          ENHDSP(*YES) RSTDSP(*YES)
             CRTBNDRPG  PGM(BENCZ1/ITMOUSER) +
                          SRCFILE(BENCZ1/QRPGLESRC) SRCMBR(ITMOUSER)

             DLTF       FILE(BENCZ1/ITSFLSD)
             MONMSG     MSGID(CPF2105)
             CRTDSPF    FILE(BENCZ1/ITSFLSD) +
                          SRCFILE(BENCZ1/QDDSSRC) SRCMBR(ITSFLSD) +
                          ENHDSP(*YES) RSTDSP(*YES)
             CRTBNDRPG  PGM(BENCZ1/ITSFLSR) +
                          SRCFILE(BENCZ1/QRPGLESRC) SRCMBR(ITSFLSR)

             DLTF       FILE(BENCZ1/ITSFLMD)
             MONMSG     MSGID(CPF2105)
             CRTDSPF    FILE(BENCZ1/ITSFLMD) +
                          SRCFILE(BENCZ1/QDDSSRC) SRCMBR(ITSFLMD) +
                          ENHDSP(*YES) RSTDSP(*YES)
             CRTBNDRPG  PGM(BENCZ1/ITSFLMR) +
                          SRCFILE(BENCZ1/QRPGLESRC) SRCMBR(ITSFLMR)

             DLTF       FILE(BENCZ1/ITMENUD)
             MONMSG     MSGID(CPF2105)
             CRTDSPF    FILE(BENCZ1/ITMENUD) +
                          SRCFILE(BENCZ1/QDDSSRC) SRCMBR(ITMENUD) +
                          ENHDSP(*YES) RSTDSP(*YES)
             CRTBNDRPG  PGM(BENCZ1/ITMENUR) +
                          SRCFILE(BENCZ1/QRPGLESRC) SRCMBR(ITMENUR)

             DLTF       FILE(BENCZ1/ITGRIDD)
             MONMSG     MSGID(CPF2105)
             CRTDSPF    FILE(BENCZ1/ITGRIDD) +
                          SRCFILE(BENCZ1/QDDSSRC) SRCMBR(ITGRIDD) +
                          ENHDSP(*YES) RSTDSP(*YES)
             CRTBNDRPG  PGM(BENCZ1/ITGRIDR) +
                          SRCFILE(BENCZ1/QRPGLESRC) SRCMBR(ITGRIDR)

             DLTF       FILE(BENCZ1/ITCOBOLD)
             MONMSG     MSGID(CPF2105)
             CRTDSPF    FILE(BENCZ1/ITCOBOLD) +
                          SRCFILE(BENCZ1/QDDSSRC) SRCMBR(ITCOBOLD) +
                          ENHDSP(*YES) RSTDSP(*YES)
             CRTBNDCBL  PGM(BENCZ1/ITCOBOLC) +
                          SRCFILE(BENCZ1/QCBLLESRC) SRCMBR(ITCOBOLC)

             DLTF       FILE(BENCZ1/DATEPOPUPD)
             MONMSG     MSGID(CPF2105)
             CRTDSPF    FILE(BENCZ1/DATEPOPUPD) +
                          SRCFILE(BENCZ1/QDDSSRC) SRCMBR(DATEPOPUPD) +
                          ENHDSP(*YES) RSTDSP(*YES)
             CRTBNDRPG  PGM(BENCZ1/DATEPOPUPR) +
                          SRCFILE(BENCZ1/QRPGLESRC) SRCMBR(DATEPOPUPR)

             DLTF       FILE(BENCZ1/WEBDOWD)
             MONMSG     MSGID(CPF2105)
             CRTDSPF    FILE(BENCZ1/WEBDOWD) +
                          SRCFILE(BENCZ1/QDDSSRC) SRCMBR(WEBDOWD) +
                          ENHDSP(*YES) RSTDSP(*YES)
             CRTSQLRPGI OBJ(BENCZ1/WEBDOWR) OBJTYPE(*PGM) +
                          SRCFILE(BENCZ1/QRPGLESRC) SRCMBR(WEBDOWR) +
                          COMMIT(*NONE) DBGVIEW(*SOURCE)

             DLTF       FILE(BENCZ1/MENUBARD)
             MONMSG     MSGID(CPF2105)
             CRTDSPF    FILE(BENCZ1/MENUBARD) +
                          SRCFILE(BENCZ1/QDDSSRC) SRCMBR(MENUBARD) +
                          ENHDSP(*YES)
             CRTBNDRPG  PGM(BENCZ1/MENUBARR) +
                          SRCFILE(BENCZ1/QRPGLESRC) SRCMBR(MENUBARR)

             ENDPGM
