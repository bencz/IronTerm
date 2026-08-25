**free
ctl-opt dftactgrp(*no) actgrp(*caller) option(*srcstmt:*nodebugio);

dcl-f ITWINDOWD workstn;

WROW = 7;
WCOL = 18;
ENTRY = 'type here';
POSMSG = 'row 7 col 18';
write BACK;

dou *in03;
    write WDEF;
    exfmt WPANEL;

    if *in05;
        WROW = %max(2 : WROW - 1);
    elseif *in06;
        WROW = %min(13 : WROW + 1);
    elseif *in07;
        WCOL = %max(2 : WCOL - 2);
    elseif *in08;
        WCOL = %min(33 : WCOL + 2);
    elseif *in09;
        write SUBDEF;
        exfmt SUBPANEL;
        *in09 = *off;
        *in12 = *off;
    endif;

    *in05 = *off;
    *in06 = *off;
    *in07 = *off;
    *in08 = *off;
    POSMSG = 'row ' + %trim(%char(WROW)) + ' col ' + %trim(%char(WCOL));
enddo;

*inlr = *on;
return;
